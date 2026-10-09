// Validação de CNPJ por dígito verificador (mod 11) — pega erro de digitação óbvio
// (14 dígitos quaisquer, tudo igual, sequência inventada) que passava reto antes,
// só caía depois na consulta opcional à Receita (CnpjService, usada pelo motoboy).
export function validarCNPJ(valor: string | null | undefined): boolean {
  const digitos = (valor ?? '').replace(/\D/g, '');
  if (digitos.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digitos)) return false;

  const calcularDigito = (base: string): number => {
    let soma = 0;
    let fator = base.length - 7;
    for (let i = 0; i < base.length; i++) {
      soma += parseInt(base[i], 10) * fator--;
      if (fator < 2) fator = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const base = digitos.slice(0, 12);
  const dv1 = calcularDigito(base);
  const dv2 = calcularDigito(base + dv1);
  return digitos === `${base}${dv1}${dv2}`;
}
