const https = require('https');

function mpRequest(body, accessToken) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadopago.com',
      path: '/checkout/preferences',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
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

  const { amount, method, name, email } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });

  const siteUrl = process.env.SITE_URL || req.headers.origin || 'https://projeto-patas-seguras.online';

  const excludedTypes = [];
  const excludedMethods = [];

  if (method === 'pix') {
    excludedTypes.push({ id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }, { id: 'atm' }, { id: 'prepaid_card' });
  } else {
    excludedTypes.push({ id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' });
    excludedMethods.push({ id: 'pix' });
  }

  try {
    const preference = await mpRequest({
      items: [{
        title: 'Doação - Projeto Patas Seguras',
        description: `Doação de R$ ${Number(amount).toFixed(2)}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(amount)
      }],
      payer: {
        name: name || 'Doador',
        email: email || undefined
      },
      payment_methods: {
        excluded_payment_methods: excludedMethods,
        excluded_payment_types: excludedTypes,
        installments: method === 'card' ? 12 : 1
      },
      back_urls: {
        success: siteUrl + '?status=approved',
        failure: siteUrl + '?status=rejected',
        pending: siteUrl + '?status=pending'
      },
      auto_return: 'approved',
      statement_descriptor: 'PATAS SEGURAS',
      external_reference: 'patas-' + method + '-' + Date.now()
    }, accessToken);

    if (preference.init_point) {
      return res.status(200).json({
        type: method,
        init_point: preference.init_point,
        id: preference.id
      });
    }

    return res.status(400).json({
      error: preference.message || 'Erro ao criar checkout',
      details: preference.cause || preference
    });
  } catch (e) {
    return res.status(500).json({ error: 'Erro de conexão: ' + e.message });
  }
};
