// preco_promo=0 não significa "grátis" — significa "sem promo cadastrada" (o form de
// produto e a edição inline de célula às vezes gravam 0 em vez de null, ex.: dono digitou
// "0" no campo). Um `preco_promo ?? price` direto trata 0 como valor válido e vende o
// produto de graça. Nenhum produto real custa R$0, então trata preco_promo<=0 como ausente.
export function precoVenda(produto: { price: number; preco_promo?: number | null }): number {
  return produto.preco_promo != null && produto.preco_promo > 0 ? produto.preco_promo : produto.price;
}
