import 'dotenv/config';
import fetch from 'node-fetch';

const {
  RENDER_API_KEY,
  RENDER_SERVICE_ID,
  EMPRESAS_BACKEND_URL,
  CONTABILY_EMAIL,
  CONTABILY_PASSWORD,
} = process.env;

async function main() {
  console.log('🔄 Renovando token Contabily...');

  // Validar variables requeridas
  const required = [
    'RENDER_API_KEY',
    'RENDER_SERVICE_ID',
    'EMPRESAS_BACKEND_URL',
    'CONTABILY_EMAIL',
    'CONTABILY_PASSWORD',
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Variable de entorno faltante: ${key}`);
    }
  }

  console.log('🔐 Haciendo login en Contabily...');

  // 1. Login completo en Contabily
  const loginRes = await fetch(`${EMPRESAS_BACKEND_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: CONTABILY_EMAIL,
      password: CONTABILY_PASSWORD,
    }),
  });

  if (!loginRes.ok) {
    const err = await loginRes.text();
    throw new Error(`Login falló: ${loginRes.status} - ${err}`);
  }

  const { tokens } = await loginRes.json();
  const newAccessToken = tokens.accessToken;

  console.log('✅ Login OK, nuevo token obtenido');

  // 2. Actualizar variable en Render
  console.log('🔄 Actualizando BACKEND1_SHARED_TOKEN en Render...');

  const res = await fetch(
    `https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ BACKEND1_SHARED_TOKEN: newAccessToken }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Error actualizando Render: ${res.status} - ${err}`);
  }

  console.log('✅ Token actualizado en Render');
  console.log('🎉 Renovación completada exitosamente');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});