// api/webhook.js
// Vercel serverless function — receives Stripe webhooks
//
// Required env vars in Vercel (Settings → Environment Variables):
//   STRIPE_SECRET_KEY      = sk_live_AlUty7cnmIzWYgNme3csmDH6
//   STRIPE_WEBHOOK_SECRET  = whsec_s0GSagoxfM0q9JRvYxDOCPD5wxcsFUnr
//
// All other credentials hardcoded below.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_live_AlUty7cnmIzWYgNme3csmDH6');

// Price IDs — map to plan
var CJ_ONLY_PRICE    = 'price_1TVCtgA6swG5FFjQAVTgxPQT';
var BUNDLE_PRICE     = 'price_1TVCthA6swG5FFjQobLWxYgm';

// Supabase
var SUPABASE_URL     = 'https://zazsgjfqcyrqeqlnieki.supabase.co';
var SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InphenNnamZxY3lycWVxbG5pZWtpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQzMzc3NiwiZXhwIjoyMDkzMDA5Nzc2fQ.bIHdT5odPq430DcNHhRrFN5vPB-jreXpcG_IclHDe_k';

// Wix
var WIX_KEY          = process.env.WIX_API_KEY || 'IST.eyJraWQiOiJQb3pIX2FDMiIsImFsZyI6IlJTMjU2In0.eyJkYXRhIjoie1wiaWRcIjpcIjQ1N2NkNDMzLWM1MzMtNDY1MS04YWNiLTc4ZGY0OTNhOGFkNlwiLFwiaWRlbnRpdHlcIjp7XCJ0eXBlXCI6XCJhcHBsaWNhdGlvblwiLFwiaWRcIjpcIjhhYmZlMjRkLTIzZGEtNDQxMS1iMzI0LWJhZjg4ODgxNmVhMVwifSxcInRlbmFudFwiOntcInR5cGVcIjpcImFjY291bnRcIixcImlkXCI6XCI5ZDY2NjdhNy1hMjg2LTQwYzQtYjhmMS0xZDE5Y2MzOGE3ZTNcIn19IiwiaWF0IjoxNzc4Mjk2MTM2fQ.M_L0WMWsVj4s9RvkKEyVd6OirWZurCXBy72NQNax7on0Qf9wLZRhVKOiBt3peKuTc_uhiE5J2q9cAfqSENQDilWDtmHzFsFuwgsziG8iBVpy2srUbMtTitl4yljqlg600Hqzdq1twBmCWsDkFnpkFZfBbE49bDVu90Jd2AcFeWk7sMPLoXvSPRJkyL_ZGIJWgqum91II68FxiGmFDcs1KWM3wY5FOSMRkxFrWdVFEeZ10IOAbsc5jU5UNGUYNvXSypswhBZNA3cfiMC963Q6DSXO8h8TNvNbSODEE7ZS8nvTeIERMH4bWN9td7-hxuVSoa-0SRa96bnHdyT8IgVCHw';
var WIX_LMC_SITE_ID  = 'bed9de38-6543-4f28-b17b-ab3448f0a4fe';
var WIX_LMC_PLAN_ID  = '34e0db7e-c790-4fae-919c-6a5162aeb0b0';

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

// Determine plan from session — checks metadata first, then falls back to price ID
async function getPlanId(session) {
  // 1. Check metadata (works for programmatic checkout)
  if (session.metadata && session.metadata.plan_id) {
    return session.metadata.plan_id;
  }

  // 2. Fetch line items and check price ID (works for payment links)
  try {
    var lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    if (lineItems.data && lineItems.data.length > 0) {
      var priceId = lineItems.data[0].price && lineItems.data[0].price.id;
      if (priceId === BUNDLE_PRICE)  return 'cj_lmc_bundle';
      if (priceId === CJ_ONLY_PRICE) return 'cj_only';
    }
  } catch (err) {
    console.error('[Webhook] Could not fetch line items:', err.message);
  }

  // 3. Check amount as last resort
  if (session.amount_total === 1500) return 'cj_lmc_bundle';
  if (session.amount_total === 1200) return 'cj_only';

  return 'cj_only'; // default
}

async function updateSupabase(email, planId) {
  var isBundle = planId === 'cj_lmc_bundle';

  // First try to update existing member
  var patchRes = await fetch(SUPABASE_URL + '/rest/v1/members?email=eq.' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ is_member: true, is_lmc_member: isBundle })
  });

  var patchData = await patchRes.json();

  // If no row was updated (new customer who paid without scanning first), insert them
  if (!Array.isArray(patchData) || patchData.length === 0) {
    console.log('[Supabase] No existing member found — creating new member for:', email);
    var insertRes = await fetch(SUPABASE_URL + '/rest/v1/members', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        email: email,
        name: email.split('@')[0],
        is_member: true,
        is_lmc_member: isBundle,
        redemption_count: 0,
        total_saved: 0,
        total_spent: 0
      })
    });
    if (!insertRes.ok) {
      var t = await insertRes.text();
      throw new Error('Supabase INSERT failed: ' + insertRes.status + ' ' + t);
    }
  }

  console.log('[Supabase] Member activated:', email, '| bundle:', isBundle);
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
    throw new Error('Wix createContact failed: ' + res.status + ' ' + JSON.stringify(data));
  }

  // 409 = already exists — get their contact ID
  var contactId = data.contact ? data.contact.id : null;

  // If 409, try to look up the existing contact
  if (!contactId && res.status === 409) {
    var searchRes = await fetch('https://www.wixapis.com/contacts/v4/contacts?filter={"info.emails.email":"' + email + '"}', {
      headers: { 'Authorization': WIX_KEY, 'wix-site-id': WIX_LMC_SITE_ID }
    });
    var searchData = await searchRes.json();
    if (searchData.contacts && searchData.contacts.length > 0) {
      contactId = searchData.contacts[0].id;
    }
  }

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
  var name  = session.customer_details && session.customer_details.name;

  if (!email) {
    console.error('[Webhook] No email in session:', session.id);
    return res.status(400).json({ error: 'No customer email in session' });
  }

  // 3. Determine plan from price ID (works for both payment links AND programmatic checkout)
  var planId = await getPlanId(session);
  console.log('[Webhook] Processing:', email, '| plan:', planId, '| session:', session.id);

  // 4. Always update Supabase
  try {
    await updateSupabase(email, planId);
  } catch (err) {
    console.error('[Webhook] Supabase error:', err.message);
    return res.status(500).json({ error: 'Supabase update failed: ' + err.message });
  }

  // 5. Bundle plan only: create Wix LMC member + activate plan
  if (planId === 'cj_lmc_bundle') {
    try {
      var contactId = await createWixContact(email, name);
      if (contactId) {
        await createWixOrder(contactId, email);
        console.log('[Wix] LMC membership activated for:', email);
      } else {
        console.warn('[Wix] Could not get contactId — manual activation needed for:', email);
      }
    } catch (err) {
      console.error('[Webhook] Wix error:', err.message);
      // Supabase already succeeded — return 200 so Stripe does not retry
      console.error('[Webhook] ACTION NEEDED: Manually activate LMC for', email);
    }
  }

  console.log('[Webhook] Done:', email);
  return res.status(200).json({ received: true, plan: planId });
}
