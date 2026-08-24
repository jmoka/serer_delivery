// Defaults do branding público do marketplace (/menu-catalog-product-browse).
// Devem bater com os valores hoje hardcoded no frontend, pra nada mudar
// visualmente até o admin editar algo em /admin/aparencia.
export const DEFAULT_APARENCIA_MARKETPLACE = {
  logo_icon: 'Utensils',
  nome_marca: 'DeliveryHub',
  header_bg_color: '#FFFFFF',
  header_bg_opacity: 95, // 0-100 — barra deslizante de transparência
  header_text_color: '#18181B',
  page_fundo_tipo: 'cor', // 'cor' | 'imagem'
  page_bg_color: '#F4F4F5',
  page_fundo_imagem_url: '',
  page_bg_opacity: 100, // vale tanto pra cor quanto pra imagem de fundo da página
  // Faixas de conteúdo entre o Hero e o rodapé (filtro geográfico, categorias,
  // carrosséis de populares/combos/tags).
  secoes_bg_color: '#FFFFFF',
  secoes_bg_opacity: 100,
  // Cor da fonte do conteúdo principal — títulos de seção (ex. "Combos em
  // destaque", "Todos os restaurantes"), categorias da sidebar, etc.
  texto_principal_color: '#18181B',
  // '' = sem fundo. Vira um "chip" atrás do título quando setado.
  texto_principal_bg_color: '',
  texto_principal_bg_opacity: 100,
  // Cor de textos secundários/legendas (ex. "0 restaurantes", subtítulos).
  texto_secundario_color: '#71717A',
  texto_secundario_bg_color: '',
  texto_secundario_bg_opacity: 100,
  hero_tagline: 'Delivery · Rápido · Confiável',
  hero_titulo: 'Seu delivery favorito',
  hero_subtitulo: 'Peça dos melhores restaurantes da sua cidade',
  hero_fundo_tipo: 'gradiente', // 'gradiente' | 'cor' | 'imagem'
  hero_fundo_cor: '#FF441F',
  hero_fundo_imagem_url: '',
  hero_fundo_opacity: 100, // vale pro gradiente padrão, cor ou imagem
  stat1_label: 'Restaurantes',
  stat2_label: 'Avaliação média',
  stat3_label: 'Min. entrega',
  stat3_valor: '~30',
  footer_bg_color: '#FFFFFF',
  footer_bg_opacity: 100,
  footer_text_color: '#71717A',
  footer_link_color: '#FF441F',
};
