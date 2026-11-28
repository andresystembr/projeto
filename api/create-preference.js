const https = require('https');

function mpRequest(path, body, accessToken) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadopago.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-Idempotency-Key': 'patas-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Resposta inválida do Mercado Pago')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado' });

  const { amount, method, name, email, doc } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });

  try {
    if (method === 'pix') {
      const payment = await mpRequest('/v1/payments', {
        transaction_amount: Number(amount),
        payment_method_id: 'pix',
        description: 'Doação - Projeto Patas Seguras',
        payer: {
          email: email || 'doador@patas.org',
          first_name: name || 'Doador',
          identification: {
            type: 'CPF',
            number: (doc || '00000000000').replace(/\D/g, '')
          }
        }
      }, accessToken);

      if (payment.id && payment.point_of_interaction) {
        const txData = payment.point_of_interaction.transaction_data;
        return res.status(200).json({
          type: 'pix',
          payment_id: payment.id,
          qr_code: txData.qr_code,
          qr_code_base64: txData.qr_code_base64,
          ticket_url: txData.ticket_url
        });
      }

      return res.status(400).json({
        error: payment.message || 'Erro ao gerar Pix',
        details: payment.cause || payment
      });
    }

    // Cartão: usa Checkout Pro (redirect)
    const siteUrl = process.env.SITE_URL || req.headers.origin || req.headers.referer?.replace(/\/$/, '') || 'https://projeto-patas-seguras.online';
    const preference = await mpRequest('/checkout/preferences', {
      items: [{
        title: 'Doação - Projeto Patas Seguras',
        description: `Doação de R$ ${Number(amount).toFixed(2)}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(amount)
      }],
      payer: { name: name || 'Doador', email: email || undefined },
      payment_methods: {
        excluded_payment_methods: [{ id: 'pix' }, { id: 'ticket' }, { id: 'atm' }],
        excluded_payment_types: [{ id: 'ticket' }],
        installments: 12
      },
      back_urls: {
        success: siteUrl + '?status=approved',
        failure: siteUrl + '?status=rejected',
        pending: siteUrl + '?status=pending'
      },
      auto_return: 'approved',
      statement_descriptor: 'PATAS SEGURAS',
      external_reference: 'patas-seguras-' + Date.now()
    }, accessToken);

    if (preference.init_point) {
      return res.status(200).json({ type: 'card', init_point: preference.init_point, id: preference.id });
    }

    return res.status(400).json({ error: preference.message || 'Erro ao criar checkout', details: preference });
  } catch (e) {
    return res.status(500).json({ error: 'Erro de conexão com Mercado Pago: ' + e.message });
  }
};
