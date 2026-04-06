// api/create-checkout.js — Crea sesión de pago en Stripe
import Stripe from 'stripe';

const PRICE_IDS = {
  pro: 'price_1TDv8SEX3Ie35WIWEVCCGwIm',
  elite: 'price_1TDv9FEX3Ie35WIWvAb6epg4',
};

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Validate userId to prevent unauthorized usage tracking manipulation
  const { plan, userId, email } = req.body;
  if (!userId || typeof userId !== "string" || userId.length === 0) {
    return res.status(400).json({ error: "userId es requerido" });
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: "Plan inválido" });

  const origin = req.headers.origin || 'https://betanalyticsIA.com';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}?payment=success&plan=${plan}`,
      cancel_url: `${origin}?payment=cancelled`,
      metadata: { userId, plan },
      customer_email: email || undefined,
    });
    return res.status(200).json({ url: session.url });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
