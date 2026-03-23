// api/webhook.js — Stripe Webhook
// Actualiza el plan del usuario en Supabase cuando paga o cancela

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service_role key (no la anon)
);

// Mapeo de Price IDs a planes
const PRICE_TO_PLAN = {
  "price_1TDv8SEX3Ie35WIWEVCCGwIm": "pro",
  "price_1TDv9FEX3Ie35WIWvAb6epg4": "elite",
};

async function setPlan(userId, plan) {
  await supabase
    .from("user_plans")
    .upsert({ user_id: userId, plan }, { onConflict: "user_id" });
}

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method not allowed");

  const sig = req.headers["stripe-signature"];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      // ── Pago exitoso — activar plan ──────────────────────
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan   = session.metadata?.plan;
        if (userId && plan) {
          await setPlan(userId, plan);
          console.log(`✅ Plan ${plan} activado para ${userId}`);
        }
        break;
      }

      // ── Renovación mensual exitosa ────────────────────────
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        if (!subId) break;
        const sub     = await stripe.subscriptions.retrieve(subId);
        const userId  = sub.metadata?.userId;
        const priceId = sub.items.data[0]?.price?.id;
        const plan    = PRICE_TO_PLAN[priceId];
        if (userId && plan) {
          await setPlan(userId, plan);
          console.log(`🔄 Renovación ${plan} para ${userId}`);
        }
        break;
      }

      // ── Pago fallido ──────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        if (!subId) break;
        const sub     = await stripe.subscriptions.retrieve(subId);
        const userId  = sub.metadata?.userId;
        if (userId) {
          await setPlan(userId, "free");
          console.log(`❌ Pago fallido — degradado a free: ${userId}`);
        }
        break;
      }

      // ── Cancelación / expiración ──────────────────────────
      case "customer.subscription.deleted": {
        const sub    = event.data.object;
        const userId = sub.metadata?.userId;
        if (userId) {
          await setPlan(userId, "free");
          console.log(`🚫 Suscripción cancelada — degradado a free: ${userId}`);
        }
        break;
      }

      default:
        console.log(`Evento ignorado: ${event.type}`);
    }
  } catch (err) {
    console.error("Webhook handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
}
