const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado' });

  const { amount, method, name, email, title, description } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });

  const excludedMethods = [];
  if (method === 'pix') {
    excludedMethods.push(
      { id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }, { id: 'atm' }
    );
  } else if (method === 'card') {
    excludedMethods.push(
      { id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' }, { id: 'pix' }
    );
  } else {
    excludedMethods.push({ id: 'ticket' }, { id: 'atm' });
  }

  const preference = {
    items: [{
      title: title || 'Doação - Projeto Patas Seguras',
      description: description || `Doação de R$ ${Number(amount).toFixed(2)}`,
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
      excluded_payment_types: [{ id: 'ticket' }],
      installments: 12
    },
    back_urls: {
      success: (process.env.SITE_URL || 'https://andresystembr.github.io/projeto') + '?status=approved',
      failure: (process.env.SITE_URL || 'https://andresystembr.github.io/projeto') + '?status=rejected',
      pending: (process.env.SITE_URL || 'https://andresystembr.github.io/projeto') + '?status=pending'
    },
    auto_return: 'approved',
    statement_descriptor: 'PATAS SEGURAS',
    external_reference: 'patas-seguras-' + Date.now()
  };

  const body = JSON.stringify(preference);

  return new Promise((resolve) => {
    const request = https.request({
      hostname: 'api.mercadopago.com',
      path: '/checkout/preferences',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.init_point) {
            res.status(200).json({ init_point: parsed.init_point, id: parsed.id });
          } else {
            res.status(400).json({ error: parsed.message || 'Erro ao criar preferência', details: parsed });
          }
        } catch (e) {
          res.status(500).json({ error: 'Erro ao processar resposta do Mercado Pago' });
        }
        resolve();
      });
    });

    request.on('error', (e) => {
      res.status(500).json({ error: 'Erro de conexão com Mercado Pago' });
      resolve();
    });

    request.write(body);
    request.end();
  });
};
