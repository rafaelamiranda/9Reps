# Supabase: fases 4 e 5 (a fazer)

Estado de partida: as fases 1 a 3 estão prontas.

- Login por e-mail e senha (`components/SupabaseAuth.jsx`).
- Dados em tabelas (`supabase/schema.sql`), servidos por `lib/supabase-api.js` atrás de `api()` em `lib/api.js`.
- Chaves em `frontend/.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). O arquivo é ignorado pelo git.
- As rotas de mídia, push e coach ainda apontam para a API antiga e respondem 404 no modo Supabase.

Antes de começar, confirme que o `schema.sql` já foi rodado no projeto e que o login funciona.

---

## Fase 4: fotos de progresso, vídeos e medidas

### O que já funciona
- **Medidas corporais** ficam em `S.measurements` e já sincronizam pela tabela `measurements` (fase 3). Falta só conferir na tela.
- **Fotos e vídeos de treino** (aba Fotos de progresso em `/stats`, `views/ProgressPhotos.jsx`) ficam no armazenamento local do aparelho. O estado só guarda o hash de cada arquivo. O arquivo em si sobe pela API antiga.

### O que fazer
O tráfego de mídia não passa por `api()`. `apiBlob` e `apiUpload` em `lib/api.js` usam `fetch` e `XMLHttpRequest` direto. Por isso o adaptador atual não cobre.

1. **Upload:** em `apiUpload`, quando `SUPABASE_ON`, enviar para o bucket `media` em `<uid>/<hash>` com `supabase.storage.from('media').upload`. Manter `onProgress` (o SDK não dá progresso, então use a URL assinada de upload com `XMLHttpRequest`).
2. **Download:** em `apiBlob`, usar `createSignedUrl` e buscar o blob. Manter `expectSize` e o timeout por inatividade.
3. **Registro:** depois do upload, inserir a linha em `public.media (user_id, hash, mime, size)`.
4. **`POST /api/media/missing`:** receber a lista de hashes e devolver os que não estão em `public.media`. Entra como rota nova em `lib/supabase-api.js`.
5. **`POST /api/media/sweep`:** apagar do Storage e da tabela o que o estado não referencia mais. Respeitar a carência de 1 hora que a API antiga usa (`api/media.js`, `noteState`).
6. **Cota e tipos:** o limite hoje está fixo em `GET /api/config` (`imageMB 10`, `gifMB 20`, `videoMB 60`, `quotaMB 1000`). Conferir contra o plano do Supabase. Validar tipo e tamanho no cliente (`lib/media-sniff.js`, `lib/media-limits.js`) e, se possível, também no bucket (`file_size_limit`, `allowed_mime_types`).
7. **Service worker:** `public/sw.js` e `lib/sw-media.test.js` tratam `/api/media/`. Conferir se o cache continua certo com URLs assinadas, que expiram.
8. **Arquivos locais antigos:** fotos que existem só no aparelho (`lib/media-store-idb.js`) precisam subir no primeiro login. `lib/media-sync.js` já faz fila de envio. Confirmar que ele usa o novo caminho.

### Critério de pronto
- Tirar uma foto no treino, ver na aba Fotos de progresso e abrir em outro aparelho logado na mesma conta.
- Controle deslizante antes e depois funciona com fotos vindas do Storage.
- Excluir a foto remove o arquivo do Storage depois da carência.
- Um usuário não consegue ler a pasta de outro (testar com duas contas).

### Riscos
- URLs assinadas expiram. O cache do service worker não pode guardar a URL como chave.
- Upload grande no celular: usar envio por partes só se o vídeo passar de 6 MB (limite do upload simples varia por plano).

---

## Fase 5: push de fim de descanso e retirada do coach de IA

### 5a. Push de descanso (Edge Function)

O app já tem `lib/push.js`, a rota `POST /api/push/rest-timer` e as tabelas `push_subscriptions` e `rest_timers` no `schema.sql`. Falta o servidor que dispara o aviso com o app fechado.

1. **Chaves VAPID:** gerar com `npx web-push generate-vapid-keys`. A chave pública vai em `frontend/.env.local` (`VITE_VAPID_PUBLIC_KEY`). A privada vai nos segredos da função (`supabase secrets set VAPID_PRIVATE_KEY=...`). Nunca commitar a privada.
2. **Rotas no adaptador** (`lib/supabase-api.js`):
   - `GET /api/push/public-key` devolve a chave pública do env.
   - `POST /api/push/subscribe` e `POST /api/push/unsubscribe` gravam e apagam em `push_subscriptions`.
   - `GET /api/push/status?endpoint=` diz se o aparelho está inscrito.
   - `POST /api/push/rest-timer` grava em `rest_timers` (`fire_at`, título, corpo). `.../cancel` apaga a linha.
   - `POST /api/push/test` chama a Edge Function de envio.
3. **Edge Function `send-due-pushes`** (`supabase/functions/send-due-pushes/index.ts`): lê `rest_timers` com `fire_at <= now()`, envia com `web-push` e apaga a linha. Usa a service role dentro da função, nunca no frontend.
4. **Agendamento:** `pg_cron` chamando a função a cada minuto não serve para descanso de 2 minutos com precisão. Duas opções:
   - Ao gravar o timer, o cliente chama a função, que espera até `fire_at` e envia (limite de tempo de execução da Edge Function).
   - `pg_cron` a cada 10 segundos com `pg_net`. Verificar se o plano permite.
5. **Cliente:** `sw.js` já recebe o `push`. Confirmar que o texto e o ícone batem e que o clique abre o treino.
6. **Limite no iPhone:** push web só funciona com o app instalado na tela inicial (iOS 16.4 ou mais).

Critério de pronto: iniciar um descanso de 2 minutos, bloquear o celular e receber o aviso com som e vibração.

### 5b. Retirar o coach de IA

Decisão já tomada: o coach sai.

1. Remover rotas e telas: `views/CoachSetup.jsx`, `CoachIntake.jsx`, `CoachChat.jsx`, `AdminCoach.jsx`, a rota `/coach/*` em `App.jsx`, e as entradas em `Settings.jsx`, `Home.jsx`, `Plan.jsx`, `QueueRow.jsx`, `sheets.jsx`.
2. Remover `lib/coach*.js`, `lib/coach-api.js`, `lib/coach-demo.js` e os testes ligados a eles.
3. Remover `api/coach/` e as rotas `/api/coach/*` e `/api/admin/coach/*` do `api/server.js`, se a API Node for mantida para quem hospeda sozinho.
4. Limpar textos do coach nos 18 arquivos de `src/locales/` e rodar `node scripts/check-locales.mjs`.
5. Remover `docs/AI_COACH.md` e a referência em `docs/README.md`.
6. O estado salvo pode ter campos do coach. Deixar o app ignorá-los sem apagar dado do usuário.

Critério de pronto: `npm run build` e `npm test` passam, e nenhuma tela mostra o coach.

---

## Ordem sugerida
1. Fase 4 (mídia), porque é o que protege fotos e dados já gravados.
2. Fase 5b (retirar coach), que é só remoção e reduz o código a manter.
3. Fase 5a (push), que depende de função publicada e das chaves.

## Pontos em aberto
- Plano do Supabase: conferir cota de Storage e limite de Edge Functions.
- Se a API Node continua existindo para quem hospeda sozinho, ou se o projeto vira só Supabase.
- O teste `sheets.day-note.test.jsx` já falhava antes destas mudanças. Vale investigar à parte.

---

## Estado do desenvolvimento

Fase 4 (código pronto, falta testar com a conta real):
- `lib/supabase-media.js` (upload por URL assinada, download, missing, sweep) e ramos em `apiBlob` e `apiUpload`.
- `schema.sql`: coluna `media.unref_since`, função `media_sweep`, limites do bucket. Rodar de novo no SQL editor (é idempotente).
- Limite de vídeo ficou em 50 MB (teto do plano Free por arquivo). Subir junto no app e no bucket em plano pago.
- O service worker já ignora requisições de outra origem, então a URL assinada não entra no cache.
- Varredura: roda depois de cada envio do estado, no máximo a cada 10 minutos. Carência de 1 hora.
- Sem envio por partes (TUS): exigiria dependência nova.

Fase 5a (código pronto, falta publicar a função):
- `lib/supabase-push.js`, rotas em `supabase-api.js`, `supabase/functions/send-due-pushes/index.ts`, `supabase/push-cron.sql` (opcional).
- Passos do usuário: gerar as chaves VAPID, `VITE_VAPID_PUBLIC_KEY` no `.env.local`, `supabase secrets set VAPID_*`, `supabase functions deploy send-due-pushes`, rodar `schema.sql` de novo.
- Descanso de até 2 minutos: o app chama a função, que espera. Acima disso depende do `push-cron.sql`.

Fase 5b (retirar o coach), só o frontend:
- Removidas as telas, `lib/coach*.js`, `coach.css` e os testes ligados. `coach-secrets.js` virou `secure-store.js` (o `cf-access.js` usa).
- Rotas `/coach/*` caem no redirecionamento para `/home`. Settings, Plan, Admin e `useStore` sem coach.
- Locales: 336 chaves órfãs removidas dos 18 arquivos. `check-locales` passa.
- Mantidos: `S.queue` (a "semana" gerenciada pelo app) e seus textos, a API Node e `api/coach/`, `docs/AI_COACH.md`.
- Campos do coach no estado salvo são ignorados, nada é apagado do dado do usuário.
- `sheets.day-note.test.jsx` segue falhando, como já falhava antes.
