# eden-core — Decisões de Arquitetura

## Propósito
Gerenciador de eventos do ecossistema Eden. Módulo público (`@eden_labs/tree`) importável por qualquer projeto do ecossistema. Implementa um event bus com at-least-once delivery sobre UDP puro (`node:dgram`) com suporte a NAT traversal via P2PTransport plugável.

A API pública principal é a classe `Eden` — encapsula toda a complexidade interna e expõe apenas `.on()`, `.emit()` e `.stop()`.

---

## Protocolo de Eventos

### Envelope — mensagem de evento
```ts
{
  id: string;        // UUID v4 — chave de deduplicação
  type: string;      // namespaced: "{ns}:{domain}:{action}"
  payload: unknown;  // tipado pelo evento concreto
  timestamp: number; // Unix ms
  version: string;   // semver do protocolo, ex: "1.0.0"
  room?: string;     // opcional — ausente = broadcast global
}
```

### Envelope — ACK
```ts
{
  type: "__ack__";
  id: string;        // ID da mensagem original
  receivedAt: number;
}
```

**IMPORTANTE:** ACKs são interceptados em `eden.ts` ANTES do `Bus.publish()` e roteados para `emitter.acknowledge(id)`. O `Receiver` NÃO envia ACK para mensagens que já são ACKs (evita cascata infinita).

### Namespacing de eventos
Formato: `{namespace}:{domain}:{action}` — obrigatório 3 segmentos separados por `:`
Exemplo: `eden:user:created`, `eden:order:updated`, `eden:chat:message`

### Broadcast
- `room` ausente → entregue a todos os subscribers daquele tipo
- `room` presente → entregue apenas aos subscribers daquela room

---

## Módulos e Responsabilidades

### `eden/eden.ts` ← ponto de entrada principal
Encapsula `Emitter`, `Receiver`, `Bus` e 3 sockets (ackSocket, listenSocket, emitSocket). É a API pública do ecossistema.
- `on(type, handler, { room? })` → `Unsubscribe` — registra listener
- `emit(type, payload, { room? })` — emite evento
- `stop()` — encerra todos os recursos (sockets + interval)
- `getPendingCount()` — retorna tamanho da fila de pendentes (útil em testes)

**Design:** cria 3 instâncias de transport via factory. Se a factory retorna a MESMA instância (ex: P2PTransport), `stop()` chamará `close()` 3× — todos os transports devem ser idempotentes em `close()`.

**ACK routing:** ao receber uma mensagem com `type === "__ack__"`, o handler em eden.ts chama `emitter.acknowledge(id)` e retorna antes do `bus.publish()`. Isso garante que a `PendingQueue` esvazie após confirmação de entrega.

### `errors/errors.ts`
Classes de erro do ecossistema Eden.
- `EdenError` — base de todos os erros
- `EdenInvalidEventTypeError` — tipo fora do formato `{ns}:{domain}:{action}`
- `EdenInvalidEnvelopeError` — envelope malformado ou com campos obrigatórios ausentes
- `EdenStunTimeoutError` — nenhum servidor STUN respondeu no prazo
- `EdenSignalingError` — servidor de sinalização retornou erro ou timeout
- `EdenSentinelError` — erro de conexão/operação do sentinel

### `envelope/envelope.ts`
Fábrica e tipo do `EventEnvelope`. Valida o formato do tipo antes de criar.
- `createEnvelope({ type, payload, room? })` → `EventEnvelope`
- Lança `EdenInvalidEventTypeError` se o tipo não seguir o formato

### `emitter/emitter.ts`
Serializa e envia envelopes via socket. Gerencia `PendingQueue` e retry automático.
- `emit(type, payload, { room? })` — emite e adiciona à fila pendente
- `acknowledge(id)` — remove da fila ao receber ACK (chamado via eden.ts, não pelo Bus)
- `retryExpired()` — reenvia expirados (chamado automaticamente via setInterval)
- `stop()` — limpa o interval
- Opções: `timeoutMs` (padrão 5000ms), `retryIntervalMs` (padrão 1000ms)

### `receiver/receiver.ts`
Desserializa o `Buffer`, valida o envelope e chama o handler. Envia ACK automaticamente.
- `handle(msg: Buffer)` — entry point para mensagens recebidas
- Lança `EdenInvalidEnvelopeError` se o JSON for inválido ou campos obrigatórios ausentes
- Envia ACK com `{ type: "__ack__", id, receivedAt }` após processar
- **NÃO envia ACK para mensagens com `type === "__ack__"`** — evita cascata infinita

### `bus/bus.ts`
Roteador pub/sub interno. Usado pelo `Eden` para distribuir eventos aos listeners.
- `subscribe(type, handler, { room? })` → `Unsubscribe`
- `publish(envelope)` — roteia para subscribers corretos, descartando duplicatas via Deduplicator

### `deduplicator/deduplicator.ts`
Mantém seen set de IDs processados. Usado pelo `Bus`.
- `seen(id)` → `boolean` — retorna true e marca como visto na primeira chamada

### `pending-queue/pending-queue.ts`
Fila de envelopes aguardando ACK. Usado pelo `Emitter`.
- `add(envelope)`, `acknowledge(id)`, `getPending()`, `getExpired()`

### `transports/transport.ts` ← interface de transporte
```ts
interface Endpoint { host: string; port: number; }
interface EdenTransport {
  send(msg: Buffer): void;
  bind(port: number, onMessage: (msg: Buffer) => void): void;
  close(): void;  // deve ser idempotente — pode ser chamado múltiplas vezes
}
```

### `transports/udp/udp-transport.ts`
Implementação padrão de `EdenTransport` sobre `node:dgram` UDP puro.
- Zero dependências externas
- `close()` idempotente via try/catch (dgram lança se já fechado)

### `transports/udp/multi-udp-transport.ts`
Implementação de `EdenTransport` com socket único para N peers simultâneos.
- `addPeer(endpoint)` / `removePeer(endpoint)` — gerencia peers via Map keyed por `host:port`
- `send(msg)` — fanout para todos os peers registrados
- `bind(port, onMessage)` — escuta qualquer origem no socket único
- `getPeerCount()` — retorna número de peers ativos (usado em testes)
- `close()` — chama `peers.clear()` antes de fechar o socket; idempotente
- **Overhead vs N UdpTransport**: negligenciável (<2%) em fanout, com vantagem de 1 fd vs N

### `transports/p2p/multi-p2p-transport.ts`
Implementação de `EdenTransport` com socket único e NAT traversal por peer.
- `addPeer(myId, targetId, signalingUrl)` — executa STUN→Signaling→HolePunch→Relay para cada peer
- `removePeer(peerId)` — remove peer, fecha relay, notifica election; se `peers.size === 0` → para election (mesh morta)
- `getPeerCount()` — retorna número de peers ativos
- `send(msg)` — fanout para todos peers (direct via UDP ou relay via WS)
- `bind(port, onMessage)` — cria socket único, filtra `PROBE_MAGIC`, `STUN_MAGIC_COOKIE` e `SENTINEL_HEARTBEAT_MAGIC`; heartbeats roteados para `election.handleHeartbeat()`
- `close()` — para election + sentinel + fecha relays + socket; idempotente
- `getElection()` — retorna instância de `SentinelElection` ou null
- `getSentinel()` — retorna instância de `SignalingSentinel` ou null
- Usa `StunClient` com `keepAlive: true, prebound: true` para não destruir socket compartilhado
- Opções de eleição: `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `cascadeStepMs`
- Com `sentinel: true`: primeiro `addPeer()` cria `SentinelElection` + `SignalingSentinel` e inicia como sentinel; promoção/demoção gerenciada automaticamente via election callbacks

### `transports/p2p/p2p-transport.ts`
Implementação de `EdenTransport` com NAT traversal automático.
- `connect(targetPeerId)` — executa STUN → Signaling → HolePunch → Relay em sequência
- `stunServers: []` → pula STUN (usa loopback/IP local)
- `punchTimeoutMs: 0` → pula hole punch, vai direto para relay
- Filtra `PROBE_MAGIC` do HolePuncher antes de entregar mensagens à aplicação
- `close()` idempotente — anula socket e relay após fechar

### `stun/stun-message.ts`
Implementação RFC 5389 do zero, sem bibliotecas externas.
- `buildBindingRequest()` → Buffer de 20 bytes + magic cookie `0x2112A442`
- `parseBindingResponse(buf)` → decodifica `XOR-MAPPED-ADDRESS` (port XOR magic >> 16, IP XOR magic)

### `stun/stun-client.ts`
Descobre endpoint público enviando Binding Request para múltiplos servidores STUN em paralelo.
- Usa o primeiro que responder
- Lança `EdenStunTimeoutError` se nenhum responder no prazo

### `signaling/signaling-client.ts`
Troca de endpoints entre peers via servidor de sinalização (WebSocket).
- `register(peerId, endpoint)` — registra no servidor
- `requestConnect(myId, targetId)` → `Endpoint` — obtém endpoint do peer
- Retry automático (5×, 200ms entre tentativas) — peer remoto pode ainda não ter registrado
- Lança `EdenSignalingError` se peer não encontrado após retries

### `hole-punch/hole-puncher.ts`
Envia probes UDP simultâneos para abrir caminho no NAT dos dois lados.
- `punch(remoteEndpoint)` → `Promise<boolean>`
- Retorna `true` quando recebe probe do outro lado
- Grace period de 300ms após receber o primeiro probe (garante simetria de NAT)
- Retorna `false` em timeout — caller decide usar relay

### `relay/relay-client.ts`
Proxy transparente via servidor de sinalização para casos de NAT simétrico estrito.
- Implementa `EdenTransport`
- Encapsula mensagens em base64 e envia via `{ type: "relay", ... }` ao signaling
- `send()` faz queue se WebSocket ainda não está aberto, envia ao abrir
- `waitForReady()` aguarda WS abrir + `identify` enviado
- `close()` usa `ws.terminate()` + silencia eventos de erro tardios

### `signaling/signaling-sentinel.ts`
Conexão persistente com signaling server via WebSocket. Mantém registro ativo do peer.
- `start()` — conecta e registra no signaling server
- `stop()` — idempotente; fecha WS e limpa timers; adiciona error handler no-op antes de `terminate()` para evitar unhandled errors assíncronos
- `isConnected()` — `true` se WS está OPEN
- `updateEndpoint(ep)` — re-registra com novo endpoint
- Reconexão automática com exponential backoff (`initialBackoffMs`, `maxBackoffMs`, `backoffMultiplier`)
- Callbacks: `onReconnect`, `onDisconnect`
- **IMPORTANTE:** ao fechar WS, sempre chamar `removeAllListeners()` seguido de `.on("error", () => {})` ANTES de `terminate()` — `ws` emite error assíncrono e sem handler causa crash

### `sentinel/sentinel-election.ts`
Eleição de sentinela peer-to-peer via heartbeat + sucessão em cascata.
- `SENTINEL_HEARTBEAT_MAGIC = "__EDEN_SENTINEL_HB__\n"` — prefixo mágico para filtragem barata em `bind()`
- `startAsSentinel()` — epoch=1, começa heartbeat imediato + periódico
- `startAsFollower()` — espera heartbeats, promove após timeout
- `handleHeartbeat(msg)` — parse + lógica de split-brain + reset de timeout
- `peerAdded(peerId)` / `peerRemoved(peerId)` — successors atualizados via `getSuccessors()` callback
- `stop()` — idempotente, limpa todos os timers
- `isSentinelActive()` / `getEpoch()`

**Heartbeat payload:** `{ sentinelId, epoch, successors, ts }` — epoch é monotônico, successors vem da ordem de inserção do Map de peers

**Sucessão em cascata:**
- Successor #0: promove após `heartbeatTimeoutMs` (default 6s)
- Successor #N: promove após `heartbeatTimeoutMs + N * cascadeStepMs` (default +2s por posição)
- Heartbeat recebido durante espera cancela promoção

**Split-brain:** epoch maior vence; mesmo epoch → peerId lexicograficamente menor vence; perdedor chama `onDemoted`

**Defaults:** `heartbeatIntervalMs=2000`, `heartbeatTimeoutMs=6000`, `cascadeStepMs=2000`

### `socket/socket.ts`
Re-exporta `UdpTransport` como `UdpSocketImpl` para compatibilidade com código antigo. Pode ser ignorado.

---

## Fluxo completo — UdpTransport

```
Eden.emit("eden:user:created", payload)
  → Emitter.emit()
      → createEnvelope() — valida type, gera UUID v4
      → PendingQueue.add(envelope)
      → UdpTransport.send() — pacote UDP para remote

Eden (receptor) — UdpTransport.bind() escuta porta
  → Receiver.handle(msg)
      → parse JSON + valida campos id e type
      → handler(envelope) em eden.ts:
          → type === "__ack__"? → emitter.acknowledge(id) → return
          → senão → Bus.publish(envelope)
              → Deduplicator.seen(id) — descarta duplicata
              → roteia por type + room
              → chama handlers registrados via .on()
      → type !== "__ack__"? → envia ACK via ackSocket

Emitter (retry automático a cada retryIntervalMs)
  → PendingQueue.getExpired()
  → reenvia via socket
  → Receiver descarta pelo Deduplicator (id já visto)
```

## Fluxo completo — P2PTransport

```
P2PTransport.connect(targetPeerId)
  1. Cria socket UDP, bind(0) → porta efêmera
  2. StunClient.discover() → endpoint público {host, port}
     (pula se stunServers=[])
  3. SignalingClient.register(peerId, endpoint)
  4. SignalingClient.requestConnect(myId, targetPeerId) → remoteEndpoint
     (retry 5× com 200ms delay — peer pode ainda não ter registrado)
  5. Se requestConnect falha → setupRelay() e retorna
  6. HolePuncher.punch(remoteEndpoint) → bool
     (pula se punchTimeoutMs=0)
  7. punched=true → this.peerEndpoint = remoteEndpoint (UDP direto)
     punched=false → setupRelay()

P2PTransport.send(msg)
  → this.relay? → relay.send(msg) via WebSocket → signaling server → peer
  → senão → socket.send(msg, peerEndpoint.port, peerEndpoint.host) — UDP direto

P2PTransport.bind(_, onMessage)
  → Filtra PROBE_MAGIC do HolePuncher
  → Registra handler no socket UDP e/ou relay
```

## Fluxo completo — Eleição de Sentinela

```
MultiP2PTransport com sentinel=true:

  Primeiro addPeer() bem-sucedido:
    → Cria SentinelElection + SignalingSentinel
    → election.startAsSentinel() → epoch=1, heartbeat imediato
    → Heartbeats enviados via transport.send() (fanout UDP/relay)

  Peers subsequentes com sentinel=true:
    → Recebem heartbeats via bind() → filtrados por SENTINEL_HEARTBEAT_MAGIC
    → election.handleHeartbeat() → armazena sentinelId, reseta timeout
    → Ficam em standby como followers

  Sentinel morre (close/crash):
    → Followers param de receber heartbeats
    → Successor #0 promove após heartbeatTimeoutMs → onPromoted()
      → Cria novo SignalingSentinel + começa heartbeats (epoch+1)
    → Successors #1..N cancelam ao receber heartbeat do novo sentinel

  Split-brain (dois sentinels simultâneos):
    → Heartbeat com epoch maior vence
    → Mesmo epoch → peerId lexicograficamente menor vence
    → Perdedor: onDemoted() → sentinel.stop(), sentinel=null

  Mesh morta (peers.size === 0):
    → election.stop(), election=null — sem sentido ser sentinel sozinho
```

---

## Estrutura de arquivos

```
src/
  __tests__/
    integration/              ← testes com rede real (npm run test:integration)
  eden/eden.ts                ← API pública principal
  errors/errors.ts
  envelope/envelope.ts
  emitter/emitter.ts
  receiver/receiver.ts
  bus/bus.ts
  deduplicator/deduplicator.ts
  pending-queue/pending-queue.ts
  socket/socket.ts            ← re-export de compatibilidade
  transports/
    transport.ts              ← interface EdenTransport + Endpoint
    udp/udp-transport.ts      ← implementação padrão (node:dgram)
    udp/multi-udp-transport.ts ← socket único para N peers (fanout)
    p2p/p2p-transport.ts      ← NAT traversal (STUN + hole punch + relay)
    p2p/multi-p2p-transport.ts ← socket único + NAT traversal por peer (N peers, 1 fd)
  stun/
    stun-message.ts           ← RFC 5389 builder/parser
    stun-client.ts            ← descobre endpoint público
  signaling/
    signaling-client.ts       ← WebSocket para troca de endpoints
    signaling-sentinel.ts     ← conexão persistente com signaling (reconexão automática)
  sentinel/
    sentinel-election.ts      ← eleição peer-to-peer (heartbeat + cascata + split-brain)
  hole-punch/
    hole-puncher.ts           ← UDP hole punching com grace period
  relay/
    relay-client.ts           ← fallback WebSocket transparente
  index.ts                    ← exports públicos
bench/
  transport.bench.ts          ← npm run bench
docs/
  ARCHITECTURE.md             ← decisões detalhadas de arquitetura
```

---

## TDD — Regras
- Nenhuma linha de produção sem teste falhando antes
- Ciclo: Red → Green → Refactor
- Testes unitários: fake socket / mock, sem I/O real
- Testes de integração (UDP real): `src/__tests__/integration/` — `npm run test:integration`
- Testes de integração (rede real): `stun-client.integration.test.ts` — CI não roda, só local

---

## Distribuição
- `@eden_labs/tree` — NPM público, ESM puro, TypeScript com exports de tipos
- SDKs para outras linguagens = repos separados implementando o mesmo protocolo de envelope

---

## Performance (loopback 127.0.0.1, ping-pong sequencial)

| Transport | p50 | p95 | Throughput |
|-----------|-----|-----|------------|
| UdpTransport (baseline) | 0.051 ms | 0.077 ms | 15.578 msg/s |
| P2PTransport hole punch | 0.053 ms | 0.074 ms | 15.230 msg/s (+2.6%) |
| P2PTransport relay | 0.104 ms | 0.158 ms | 8.176 msg/s (+103%) |

Overhead do hole punch pós-conexão é negligenciável. Relay tem ~2× overhead por usar TCP/WebSocket.

---

## Decisões Fechadas

### Protocolo e entrega
- [x] UDP puro via `node:dgram` — sem Socket.IO, sem WebSocket no caminho principal
- [x] At-least-once + idempotent consumer (deduplicação por UUID v4)
- [x] Retry automático no Emitter via setInterval
- [x] ACK automático no Receiver — NÃO para mensagens `type === "__ack__"` (evita cascata)
- [x] ACKs interceptados em `eden.ts` antes do Bus → `emitter.acknowledge(id)` (não `bus.publish`)
- [x] `Eden` como API principal — encapsula toda complexidade interna
- [x] Broadcast global (room ausente) + rooms opcionais
- [x] Erros tipados com hierarquia `EdenError`

### Transport plugável
- [x] Interface `EdenTransport` permite outros transportes sem mudar Emitter/Receiver
- [x] `Eden` recebe `transport?: (target) => EdenTransport` — default `UdpTransport`
- [x] `UdpTransport.close()` idempotente — factory pode retornar mesma instância 3× para ackSocket/listenSocket/emitSocket
- [x] Mesma idempotência em `P2PTransport.close()`
- [x] `MultiUdpTransport` — socket único para N peers; `close()` chama `peers.clear()` antes de fechar socket; overhead <2% vs N UdpTransport em fanout
- [x] `MultiP2PTransport` — socket único + NAT traversal por peer; `addPeer(myId, targetId, signalingUrl)` executa STUN→Signaling→HolePunch→Relay; `removePeer(peerId)` fecha relay se necessário

### NAT Traversal
- [x] STUN RFC 5389 do zero (zero deps externas) — `stun-message.ts`
- [x] Hole punching com grace period de 300ms para simetria de NAT
- [x] HolePuncher filtra por `rinfo` (address+port) — evita que probe de peer errado resolva punchers paralelos
- [x] HolePuncher remove listener via `socket.off()` após resolver (direto ou timeout) — sem vazamento em socket compartilhado
- [x] `stunServers: []` pula STUN (mesmo host/rede local)
- [x] `punchTimeoutMs: 0` pula hole punch, vai direto para relay
- [x] Relay via WebSocket signaling server — fallback para NAT simétrico estrito
- [x] Relay `send()` faz queue se WS ainda não abriu (sem race condition)
- [x] Signaling com retry (5×, 200ms) — peer remoto pode registrar com delay
- [x] `PROBE_MAGIC` filtrado no `P2PTransport.bind()` e `MultiP2PTransport.bind()` antes de chegar na aplicação
- [x] `StunClient` suporta `keepAlive: true` (não fecha socket compartilhado) e `prebound: true` (pula socket.bind() se já bound)

### Sentinel e Eleição
- [x] `SignalingSentinel` — conexão persistente com signaling server; reconexão com exponential backoff
- [x] `SignalingSentinel.stop()` adiciona error handler no-op após `removeAllListeners()` antes de `terminate()` — evita crash por error assíncrono do `ws`
- [x] `SentinelElection` — eleição peer-to-peer sem mudanças no signaling server
- [x] Heartbeat via transport layer (`send()` → fanout UDP/relay) com prefixo mágico `SENTINEL_HEARTBEAT_MAGIC`
- [x] Sucessão em cascata: successor #N espera `timeoutMs + N * cascadeStepMs` — evita eleição simultânea
- [x] Split-brain: epoch maior vence; mesmo epoch → peerId menor vence — determinístico, sem coordenação
- [x] `MultiP2PTransport.bind()` filtra heartbeats antes de entregar ao app (mesmo padrão de `PROBE_MAGIC` e `STUN_MAGIC_COOKIE`)
- [x] `removePeer()` com `peers.size === 0` para election — mesh morta, sem sentido ser sentinel
- [x] `onPromoted` cria `SignalingSentinel`; `onDemoted` destrói — sentinel só existe no peer ativo

### Multi-linguagem
- [x] SDKs para outras linguagens = repos separados com mesmo protocolo de envelope
