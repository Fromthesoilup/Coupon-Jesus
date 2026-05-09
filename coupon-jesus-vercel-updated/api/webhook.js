// api/webhook.js
// Vercel serverless function — receives Stripe webhooks
//
// Only two env vars REQUIRED in Vercel (everything else is hardcoded below):
//   STRIPE_SECRET_KEY      = (from Vercel env vars)
//   STRIPE_WEBHOOK_SECRET  = whsec_...  (from Stripe after adding endpoint)
//
// All other credentials are hardcoded as fallbacks for zero-config deploy.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Hardcoded credentials (safe on server-side only) ──────────────────────
var SUPABASE_URL     = 'https://zazsgjfqcyrqeqlnieki.supabase.co';
var SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InphenNnamZxY3lycWVxbG5pZWtpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQzMzc3NiwiZXhwIjoyMDkzMDA5Nzc2fQ.bIHdT5odPq430DcNHhRrFN5vPB-jreXpcG_IclHDe_k';
var WIX_KEY         = process.env.WIX_API_KEY || 'IST.eyJraWQiOiJQb3pIX2FDMiIsImFsZyI6IlJTMjU2In0.eyJkYXRhIjoie1wiaWRcIjpcIjQ1N2NkNDMzLWM1MzMtNDY1MS04YWNiLTc4ZGY0OTNhOGFkNlwiLFwiaWRlbnRpdHlcIjp7XCJ0eXBlXCI6XCJhcHBsaWNhdGlvblwiLFwiaWRcIjpcIjhhYmZlMjRkLTIzZGEtNDQxMS1iMzI0LWJhZjg4ODgxNmVhMVwifSxcInRlbmFudFwiOntcInR5cGVcIjpcImFjY291bnRcIixcImlkXCI6XCI5ZDY2NjdhNy1hMjg2LTQwYzQtYjhmMS0xZDE5Y2MzOGE3ZTNcIn19IiwiaWF0IjoxNzc4Mjk2MTM2fQ.M_L0WMWsVj4s9RvkKEyVd6OirWZurCXBy72NQNax7on0Qf9wLZRhVKOiBt3peKuTc_uhiE5J2q9cAfqSENQDilWDtmHzFsFuwgsziG8iBVpy2srUbMtTitl4yljqlg600Hqzdq1twBmCWsDkFnpkFZfBbE49bDVu90Jd2AcFeWk7sMPLoXvSPRJkyL_ZGIJWgqum91II68FxiGmFDcs1KWM3wY5FOSMRkxFrWdVFEeZ10IOAbsc5jU5UNGUYNvXSypswhBZNA3cfiMC963Q6DSXO8h8TNvNbSODEE7ZS8nvTeIERMH4bWN9td7-hxuVSoa-0SRa96bnHdyT8IgVCHw';
var WIX_LMC_SITE_ID = 'bed9de38-6543-4f28-b17b-ab3448f0a4fe';
var WIX_LMC_PLAN_ID = '34e0db7e-c790-4fae-919c-6a5162aeb0b0';

// Disable body parsing — Stripe needs raw body to verify signatures
export const config = { api: { bodyParser: false } };

// ─── helpers ────────────────────────────────────────────────────────────────

function getRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function updateSupabase(email, planId) {
  var isBundle = planId === 'cj_lmc_bundle';

  var res = await fetch(SUPABASE_URL + '/rest/v1/members?email=eq.' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ is_member: true, is_lmc_member: isBundle })
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error('Supabase PATCH failed: ' + res.status + ' ' + text);
  }

  console.log('[Supabase] Updated member:', email, '| bundle:', isBundle);
}

async function createWixContact(email, name) {
  var res = await fetch('https://www.wixapis.com/contacts/v4/contacts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': WIX_KEY,
      'wix-site-id': WIX_LMC_SITE_ID
    },
    body: JSON.stringify({
      info: {
        name: { full: name || email },
        emails: { items: [{ email: email, tag: 'MAIN' }] }
      }
    })
  });

  var data = await res.json();

  if (!res.ok && res.status !== 409) {
    // 409 = contact already exists — that is fine
    throw new Error('Wix createContact failed: ' + res.status + ' ' + JSON.stringify(data));
  }

  var contactId = data.contact ? data.contact.id : null;
  console.log('[Wix] Contact upserted:', email, '| contactId:', contactId);
  return contactId;
}

async function createWixOrder(contactId, email) {
  var res = await fetch('https://www.wixapis.com/pricing-plans/v2/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': WIX_KEY,
      'wix-site-id': WIX_LMC_SITE_ID
    },
    body: JSON.stringify({
      planId: WIX_LMC_PLAN_ID,
      memberId: contactId,
      paymentDetails: { paymentType: 'OFFLINE' }
    })
  });

  var data = await res.json();

  if (!res.ok) {
    throw new Error('Wix createOrder failed: ' + res.status + ' ' + JSON.stringify(data));
  }

  console.log('[Wix] Plan order created for:', email, '| orderId:', data.order && data.order.id);
}

// ─── main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Verify Stripe signature
  var event;
  try {
    var rawBody = await getRawBody(req);
    var sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature invalid: ' + err.message });
  }

  // 2. Only handle completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, skipped: event.type });
  }

  var session = event.data.object;
  var email = session.customer_details && session.customer_details.email;
  var name = session.customer_details && session.customer_details.name;
  var planId = session.metadata && session.metadata.plan_id;

  if (!email || !planId) {
    console.error('[Webhook] Missing email or plan_id in session:', session.id);
    return res.status(400).json({ error: 'Missing email or plan_id metadata' });
  }

  console.log('[Webhook] Processing:', email, '| plan:', planId);

  // 3. Always update Supabase
  try {
    await updateSupabase(email, planId);
  } catch (err) {
    console.error('[Webhook] Supabase error:', err.message);
    return res.status(500).json({ error: 'Supabase update failed: ' + err.message });
  }

  // 4. Bundle plan only: create Wix contact + activate LMC plan
  if (planId === 'cj_lmc_bundle') {
    try {
      var contactId = await createWixContact(email, name);
      if (contactId) {
        await createWixOrder(contactId, email);
      } else {
        console.warn('[Wix] No contactId returned — order skipped. Activate LMC manually for:', email);
      }
    } catch (err) {
      console.error('[Webhook] Wix error:', err.message);
      // Supabase already succeeded — return 200 so Stripe does not retry.
      console.error('[Webhook] ACTION NEEDED: Manually activate LMC for', email);
    }
  }

  console.log('[Webhook] Done:', email);
  return res.status(200).json({ received: true });
}
