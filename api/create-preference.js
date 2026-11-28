const https = require('https');

function mpRequest(method, path, body, accessToken) {
  const data = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mercadopago.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    };
    if (method !== 'GET') {
      options.headers['X-Idempotency-Key'] = 'patas-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    }
    if (data && method !== 'GET') {
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(responseBody) }); }
        catch (e) { resolve({ status: res.statusCode, data: { raw: responseBody } }); }
      });
    });
    req.on('error', reject);
    if (data && method !== 'GET') req.write(data);
    req.end();
  });
}

const STORE_EXTERNAL_ID = 'patassegurasonline01';
const POS_EXTERNAL_ID = 'patasseguraspos01';

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
      const userResp = await mpRequest('GET', '/users/me', null, accessToken);
      if (!userResp.data.id) {
        return res.status(400).json({ error: 'Erro ao obter dados da conta' });
      }
      const userId = userResp.data.id;

      let storeId;
      const storeResp = await mpRequest('POST', '/users/' + userId + '/stores', {
        name: 'Projeto Patas Seguras',
        external_id: STORE_EXTERNAL_ID,
        location: {
          street_name: 'Avenida Paulista',
          street_number: '1000',
          city_name: 'São Paulo',
          state_name: 'São Paulo',
          latitude: -23.5614,
          longitude: -46.6558
        }
      }, accessToken);

      if (storeResp.data.id) {
        storeId = storeResp.data.id;
      } else {
        const storesListResp = await mpRequest('GET', '/users/' + userId + '/stores/search?external_id=' + STORE_EXTERNAL_ID, null, accessToken);
        if (storesListResp.data.results && storesListResp.data.results.length > 0) {
          storeId = storesListResp.data.results[0].id;
        } else if (storesListResp.data.id) {
          storeId = storesListResp.data.id;
        }
      }

      if (!storeId) {
        return res.status(400).json({ error: 'Erro ao criar loja' });
      }

      const posResp = await mpRequest('POST', '/pos', {
        name: 'Doacoes Online',
        external_id: POS_EXTERNAL_ID,
        store_id: Number(storeId),
        fixed_amount: false,
        category: 5611203
      }, accessToken);

      const qrResp = await mpRequest('PUT',
        '/instore/orders/qr/seller/collectors/' + userId + '/pos/' + POS_EXTERNAL_ID + '/qrs',
        {
          external_reference: 'doacao-' + Date.now(),
          title: 'Doacao - Projeto Patas Seguras',
          description: 'Doacao de R$ ' + Number(amount).toFixed(2),
          total_amount: Number(amount),
          items: [{
            title: 'Doacao - Projeto Patas Seguras',
            unit_price: Number(amount),
            quantity: 1,
            unit_measure: 'unit',
            total_amount: Number(amount)
          }]
        }, accessToken);

      if (qrResp.data.qr_data) {
        return res.status(200).json({
          type: 'pix',
          qr_data: qrResp.data.qr_data,
          in_store_order_id: qrResp.data.in_store_order_id
        });
      }

      return res.status(400).json({ error: 'Erro ao gerar QR Code' });
    }

    // Cartão: Checkout Pro
    const prefResp = await mpRequest('POST', '/checkout/preferences', {
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

    if (prefResp.data.init_point) {
      return res.status(200).json({ type: 'card', init_point: prefResp.data.init_point });
    }

    return res.status(400).json({ error: prefResp.data.message || 'Erro ao criar checkout' });
  } catch (e) {
    return res.status(500).json({ error: 'Erro de conexão: ' + e.message });
  }
};
