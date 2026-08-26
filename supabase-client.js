// Pequeno arquivo "ponte" para o cliente do Supabase.
// Mantém app.js desacoplado de onde o supabase-js vem - facilita trocar
// o CDN no futuro (ou usar um build local) sem mexer no resto do código.
export { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
