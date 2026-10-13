# Publicar na Vercel

O app é estático (Vite, `HashRouter`), então não precisa de regra de rewrite. O backend é o Supabase.

## Projeto na Vercel
- Root Directory: `frontend`. O `frontend/vercel.json` já traz install, build, saída (`dist`) e cabeçalhos.
- O build copia as imagens e animações dos exercícios (`catalogue/media`, 180 px) para `dist/exercise-media`. Isso exige "Include files outside the Root Directory" ligado (é o padrão).
- Variáveis de ambiente (Production e Preview), todas lidas no build:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_VAPID_PUBLIC_KEY`
- Mudou uma variável: faça um novo deploy, porque elas entram no bundle.

## Supabase
- Authentication, URL Configuration: Site URL e Redirect URLs com o domínio da Vercel (e o de preview, se for usar).
- Rodar `supabase/schema.sql` no SQL editor.
- Segredos e função de push: `supabase secrets set --env-file supabase/.env.secrets` e `supabase functions deploy send-due-pushes`.

## Pontos de atenção
- Tamanho: o `dist` tem cerca de 238 MB e 13 mil arquivos, quase tudo mídia. Confira os limites do seu plano da Vercel. Se passar, hospede a mídia fora e defina `VITE_IMG_BASE` e `VITE_GIF_BASE` no build (são valores de build).
- Push só funciona em HTTPS (a Vercel já é) e, no iPhone, com o app instalado na tela inicial.
- O `sw.js` e o `index.html` saem com `no-cache` para o app atualizar logo depois de um deploy.
