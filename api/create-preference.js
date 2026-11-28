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
        catch (e) { reject(new Error('Resposta inválida')); }
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

  const { amount, method } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });

  const siteUrl = req.headers.origin || 'https://projeto-patas-seguras.online';

  try {
    if (method === 'pix') {
      // Tenta gerar Pix inline via Payments API
      try {
        const payment = await mpRequest('/v1/payments', {
          transaction_amount: Number(amount),
          payment_method_id: 'pix',
          description: 'Doação - Projeto Patas Seguras',
          payer: {
            email: 'doador@projetopatasseguras.org'
          }
        }, accessToken);

        if (payment.id && payment.point_of_interaction) {
          const txData = payment.point_of_interaction.transaction_data;
          return res.status(200).json({
            type: 'pix',
            payment_id: payment.id,
            qr_code: txData.qr_code,
            qr_code_base64: txData.qr_code_base64
          });
        }
      } catch (e) {
        // Pix inline falhou, cai no fallback abaixo
      }

      // Fallback: Checkout Pro com Pix habilitado
      const preference = await mpRequest('/checkout/preferences', {
        items: [{
          title: 'Doação - Projeto Patas Seguras',
          description: 'Doação de R$ ' + Number(amount).toFixed(2),
          quantity: 1,
          currency_id: 'BRL',
          unit_price: Number(amount)
        }],
        payment_methods: {
          excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }],
          installments: 1
        },
        back_urls: {
          success: siteUrl + '?status=approved',
          failure: siteUrl + '?status=rejected',
          pending: siteUrl + '?status=pending'
        },
        auto_return: 'approved',
        statement_descriptor: 'PATAS SEGURAS'
      }, accessToken);

      if (preference.init_point) {
        return res.status(200).json({ type: 'pix_redirect', init_point: preference.init_point });
      }

      return res.status(400).json({ error: 'Erro ao gerar Pix' });
    }

    // Cartão: Checkout Pro
    const preference = await mpRequest('/checkout/preferences', {
      items: [{
        title: 'Doação - Projeto Patas Seguras',
        description: 'Doação de R$ ' + Number(amount).toFixed(2),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(amount)
      }],
      payment_methods: {
        excluded_payment_methods: [{ id: 'pix' }],
        excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }],
        installments: 12
      },
      back_urls: {
        success: siteUrl + '?status=approved',
        failure: siteUrl + '?status=rejected',
        pending: siteUrl + '?status=pending'
      },
      auto_return: 'approved',
      statement_descriptor: 'PATAS SEGURAS'
    }, accessToken);

    if (preference.init_point) {
      return res.status(200).json({ type: 'card', init_point: preference.init_point });
    }

    return res.status(400).json({ error: preference.message || 'Erro ao criar checkout' });
  } catch (e) {
    return res.status(500).json({ error: 'Erro de conexão: ' + e.message });
  }
};
