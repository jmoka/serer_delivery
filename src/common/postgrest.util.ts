// Caracteres com significado especial no DSL de filtro do PostgREST — vírgula
// separa condições dentro de um .or(...), parênteses aninham and()/or(...).
// Um termo de busca livre com esses caracteres, interpolado sem sanitizar
// dentro de um `.or(\`col.ilike.%${busca}%\`)`, injeta cláusulas extras no
// filtro (mesma classe de bug documentada em motoboy-auth.service.ts
// EMAIL_RE/PHONE_RE — lá resolvida restringindo o formato aceito; aqui, como
// é busca livre, a solução é remover os caracteres perigosos em vez de
// rejeitar a busca inteira).
export const sanitizarBuscaOr = (valor: string): string => valor.replace(/[,()]/g, '');
