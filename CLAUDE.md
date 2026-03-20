# eden-core — Decisões de Arquitetura

## Propósito
Gerenciador de eventos do ecossistema Eden. Módulo público (`@eden_labs/root`) importável por qualquer projeto do ecossistema. Implementa um event bus com at-least-once delivery sobre UDP puro (`node:dgram`) com suporte a NAT traversal via P2PTransport plugável.

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
    p2p/p2p-transport.ts      ← NAT traversal (STUN + hole punch + relay)
  stun/
    stun-message.ts           ← RFC 5389 builder/parser
    stun-client.ts            ← descobre endpoint público
  signaling/
    signaling-client.ts       ← WebSocket para troca de endpoints
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
- `@eden_labs/root` — NPM público, ESM puro, TypeScript com exports de tipos
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

### NAT Traversal
- [x] STUN RFC 5389 do zero (zero deps externas) — `stun-message.ts`
- [x] Hole punching com grace period de 300ms para simetria de NAT
- [x] `stunServers: []` pula STUN (mesmo host/rede local)
- [x] `punchTimeoutMs: 0` pula hole punch, vai direto para relay
- [x] Relay via WebSocket signaling server — fallback para NAT simétrico estrito
- [x] Relay `send()` faz queue se WS ainda não abriu (sem race condition)
- [x] Signaling com retry (5×, 200ms) — peer remoto pode registrar com delay
- [x] `PROBE_MAGIC` filtrado no `P2PTransport.bind()` antes de chegar na aplicação

### Multi-linguagem
- [x] SDKs para outras linguagens = repos separados com mesmo protocolo de envelope
