import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from '../motoboy/geocoding.service';
import { PlanosService } from '../planos/planos.service';
import { UsuariosService } from '../usuarios/usuarios.service';

@Controller('restaurante')
export class OnboardingController {
  constructor(
    private supabase: SupabaseService,
    private geocoding: GeocodingService,
    private planos: PlanosService,
    private usuarios: UsuariosService,
  ) {}

  // Público (sem guard) — a wizard de cadastro mostra os planos antes do
  // usuário logar/criar conta, pra ele escolher já na primeira etapa.
  @Get('planos-disponiveis')
  planosDisponiveis() {
    return this.planos.listarPlanosAtivos('saas');
  }

  private normalizarDigitos(v?: string | null): string | null {
    const d = (v ?? '').replace(/\D/g, '');
    return d || null;
  }

  private normalizarEmail(v?: string | null): string | null {
    const e = (v ?? '').trim().toLowerCase();
    return e || null;
  }

  // Checa CNPJ/WhatsApp/email contra os demais restaurantes (excluindo o
  // próprio, pra reenvio do mesmo formulário não acusar conflito consigo
  // mesmo). CNPJ é opcional — null nunca conflita (UNIQUE do Postgres também
  // trata assim).
  private async checarDuplicados(
    restaurantId: number,
    valores: { cnpj: string | null; whatsapp: string | null; email: string | null },
  ) {
    const ors: string[] = [];
    if (valores.cnpj) ors.push(`cnpj.eq.${valores.cnpj}`);
    if (valores.whatsapp) ors.push(`whatsapp.eq.${valores.whatsapp}`);
    if (valores.email) ors.push(`email.eq.${valores.email}`);
    if (!ors.length) return { cnpj: false, whatsapp: false, email: false };

    const { data, error } = await this.supabase.client
      .from('restaurants')
      .select('id, cnpj, whatsapp, email')
      .or(ors.join(','))
      .neq('id', restaurantId);
    if (error) throw error;

    const conflita = (campo: 'cnpj' | 'whatsapp' | 'email', valor: string | null) =>
      !!valor && (data ?? []).some((r: any) => r[campo] === valor);

    return {
      cnpj: conflita('cnpj', valores.cnpj),
      whatsapp: conflita('whatsapp', valores.whatsapp),
      email: conflita('email', valores.email),
    };
  }

  // Checagem em tempo real usada pela wizard (passos "business"/"contact")
  // pra avisar de duplicidade assim que o usuário sai do campo, em vez de só
  // no /finalizar (último passo) — bem tarde pra descobrir que o CNPJ digitado
  // 3 passos atrás já está em uso.
  @Post('verificar-disponibilidade')
  @UseGuards(RestaurantOwnerGuard)
  async verificarDisponibilidade(
    @Req() req: any,
    @Body() body: { cnpj?: string; whatsapp?: string; email?: string },
  ) {
    const restaurantId: number = req.restaurantId;
    const duplicados = await this.checarDuplicados(restaurantId, {
      cnpj: this.normalizarDigitos(body.cnpj),
      whatsapp: this.normalizarDigitos(body.whatsapp),
      email: this.normalizarEmail(body.email),
    });
    return {
      cnpj_disponivel: !duplicados.cnpj,
      whatsapp_disponivel: !duplicados.whatsapp,
      email_disponivel: !duplicados.email,
    };
  }

  // 1ª fase do cadastro: cria a loja só com nome + assinatura do plano
  // escolhido, e cobra a fatura do período atual na hora se o plano não tiver
  // trial. O resto do formulário (endereço, horários, tipo...) só é liberado
  // na wizard depois que essa fatura confirmar paga (ou, se for plano com
  // trial, direto). Idempotente: se o usuário já tem restaurante (reload no
  // meio do checkout), retorna o estado atual em vez de criar de novo.
  @Post('registrar-inicial')
  @UseGuards(JwtGuard)
  async registrarInicial(@Req() req: any, @Body() body: { name?: string; plano_id?: number }) {
    const userId: string = req.userId;

    const { data: existing } = await this.supabase.client
      .from('restaurants')
      .select('id, name')
      .eq('user_id', userId)
      .maybeSingle();

    let restaurant = existing;
    let precisaAssinar = false;

    if (!restaurant) {
      if (!body.name?.trim()) throw new BadRequestException('Nome do estabelecimento é obrigatório.');
      if (!body.plano_id) throw new BadRequestException('Selecione um plano para continuar.');

      const slug = body.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').trim();

      const { data: novo, error } = await this.supabase.client
        .from('restaurants')
        .insert({ name: body.name, user_id: userId, slug })
        .select('id, name')
        .single();
      if (error) throw error;
      restaurant = novo;
      precisaAssinar = true;
    } else if (body.plano_id) {
      // Já tem loja (voltou nesse passo, ou reload) — só reassina se o plano
      // escolhido agora for DIFERENTE do que já está na assinatura. Sem essa
      // checagem, trocar de plano na wizard e clicar Continuar de novo
      // ignorava a nova escolha e reaproveitava fatura/trial do plano antigo.
      const { assinatura } = await this.planos.buscarAssinaturaPorRestaurante(restaurant.id);
      precisaAssinar = assinatura.plano_id !== body.plano_id;

      if (precisaAssinar) {
        // Role só eleva pra restaurant_owner no /finalizar — se ainda é
        // 'customer', o usuário está só comparando planos, nada foi pago.
        // Cancela fatura pendente do plano anterior pra não ficar presa
        // bloqueando o plano novo escolhido (ex: trial). Restrito a esse
        // estado pra não deixar um dono já pagante cancelar dívida real só
        // reenviando outro plano_id nesse endpoint.
        const { data: perfil } = await this.supabase.client
          .from('user_profiles').select('role').eq('id', userId).maybeSingle();
        if (perfil?.role !== 'restaurant_owner') {
          await this.supabase.client
            .from('plano_faturas')
            .update({ status: 'cancelada', atualizado_em: new Date().toISOString() })
            .eq('assinatura_id', assinatura.id)
            .in('status', ['pendente', 'vencida']);
        }
      }
    }

    let status: { fatura_pendente_id: number | null };
    if (precisaAssinar) {
      // precisaAssinar só fica true quando body.plano_id já foi validado como
      // presente (loja nova) ou veio no body pra decidir a troca (loja existente).
      const planoId = body.plano_id as number;
      const plano = await this.planos.buscarPlano(planoId);
      await this.planos.atribuirAssinatura({ restaurantId: restaurant.id }, planoId);

      // Sem trial: gera (forçado) a fatura do período atual pra cobrar já no
      // cadastro. Com trial, não força nada — fica pra próxima renovação natural.
      const temTrial = (plano.trial_dias ?? 0) > 0;
      status = await this.planos.sincronizarPeriodo({ restaurantId: restaurant.id }, !temTrial);
    } else {
      status = await this.planos.sincronizarPeriodo({ restaurantId: restaurant.id });
    }

    if (!status.fatura_pendente_id) {
      // Assinou plano com trial (sem cobrança) — já vira dono aqui, sem esperar
      // o resto da wizard (endereço, horários...). Restrito a precisaAssinar pra
      // não elevar num reload de loja com assinatura cancelada (que também cai
      // em fatura_pendente_id null, mas não é uma assinatura ativa de verdade).
      if (precisaAssinar) await this.usuarios.sincronizarVinculoDono(restaurant.id, userId);
      return { restaurant, precisa_pagamento: false, fatura: null };
    }

    const fatura = await this.planos.buscarFaturaDoRestaurante(restaurant.id, status.fatura_pendente_id);
    return { restaurant, precisa_pagamento: true, fatura };
  }

  // 2ª fase: completa o cadastro (endereço, horários, tipo de estabelecimento)
  // e eleva o role pra restaurant_owner — só chamada depois que a wizard
  // liberou o formulário (plano pago ou em trial).
  @Post('finalizar')
  @UseGuards(RestaurantOwnerGuard)
  async finalizar(
    @Req() req: any,
    @Body()
    body: {
      name?: string;
      address?: string;
      state?: string;
      city?: string;
      neighborhood?: string;
      cep?: string;
      business_hours?: object;
      type_id?: number;
      cnpj?: string;
      whatsapp?: string;
      email?: string;
    },
  ) {
    const restaurantId: number = req.restaurantId;
    const userId: string = req.userId;

    const cnpjNorm = this.normalizarDigitos(body.cnpj);
    const whatsappNorm = this.normalizarDigitos(body.whatsapp);
    const emailNorm = this.normalizarEmail(body.email);

    // Última barreira antes de gravar — a wizard já checou isso passo a passo
    // (verificar-disponibilidade), mas dois cadastros concorrentes com o mesmo
    // CNPJ/WhatsApp/email só se pegam aqui (e na UNIQUE constraint do banco).
    const duplicados = await this.checarDuplicados(restaurantId, {
      cnpj: cnpjNorm,
      whatsapp: whatsappNorm,
      email: emailNorm,
    });
    const mensagens: string[] = [];
    if (duplicados.cnpj) mensagens.push('Este CNPJ já está cadastrado em outro estabelecimento.');
    if (duplicados.whatsapp) mensagens.push('Este WhatsApp já está cadastrado em outro estabelecimento.');
    if (duplicados.email) mensagens.push('Este email já está cadastrado em outro estabelecimento.');
    if (mensagens.length) throw new BadRequestException(mensagens.join(' '));

    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) campos.name = body.name;
    if (body.address !== undefined) campos.address = body.address;
    if (body.state !== undefined) campos.state = body.state;
    if (body.city !== undefined) campos.city = body.city;
    if (body.neighborhood !== undefined) campos.neighborhood = body.neighborhood;
    if (body.cep !== undefined) campos.cep = body.cep ? body.cep.replace(/\D/g, '') : null;
    if (body.business_hours !== undefined) campos.business_hours = body.business_hours;
    if (body.type_id !== undefined) campos.type_id = body.type_id;
    if (body.cnpj !== undefined) campos.cnpj = cnpjNorm;
    if (body.whatsapp !== undefined) campos.whatsapp = whatsappNorm;
    if (body.email !== undefined) campos.email = emailNorm;

    const { data: restaurant, error } = await this.supabase.client
      .from('restaurants')
      .update(campos)
      .eq('id', restaurantId)
      .select()
      .single();
    if (error) {
      // Última rede de segurança contra corrida (dois cadastros com o mesmo
      // CNPJ/WhatsApp/email confirmando entre a checagem acima e este update).
      if ((error as any).code === '23505') {
        throw new BadRequestException('CNPJ, WhatsApp ou email já cadastrado em outro estabelecimento.');
      }
      throw error;
    }

    // Geocodifica em background (best-effort) — sem isso o restaurante nunca aparece no
    // filtro por raio/km da home até o dono re-salvar o endereço em Config manualmente.
    if (restaurant.address || restaurant.cep) {
      const texto = [restaurant.address, restaurant.neighborhood, restaurant.city, restaurant.state, restaurant.cep]
        .filter(Boolean).join(', ');
      this.geocoding.geocodeEndereco(texto).then((coords) => {
        if (!coords) return;
        return this.supabase.client
          .from('restaurants')
          .update({ lat: coords.lat, lng: coords.lng, geocoded_at: new Date().toISOString(), geocode_falhou: false })
          .eq('id', restaurant.id);
      }).catch(() => {});
    }

    // Eleva role para restaurant_owner — propaga erro em vez de engolir, senão
    // o endpoint responde 200 mesmo com o vínculo quebrado (causa raiz de um
    // bug em produção onde o dono nunca via o botão do painel).
    await this.usuarios.sincronizarVinculoDono(restaurantId, userId);

    return { restaurant };
  }
}
