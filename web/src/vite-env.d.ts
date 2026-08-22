/// <reference types="vite/client" />

// Nenhuma variável `VITE_*` é declarada de propósito: esta tela não recebe
// credencial no cliente. `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` vivem sem
// prefixo, são lidas por `loadEnv` no `vite.config.ts` e ficam no proxy.
