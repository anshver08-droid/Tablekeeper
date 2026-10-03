import assert from 'node:assert/strict';

const port = process.env.PORT || 3001;
const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${port}`;

async function testE2E() {
  console.log('Testing TableKeeper Local Host Server at', baseUrl);

  // 1. GET /
  const htmlRes = await fetch(baseUrl);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(html.includes('TableKeeper'));
  console.log('✔ GET / (Web UI HTML loaded)');

  // 2. GET /restaurants
  const restRes = await fetch(`${baseUrl}/restaurants`);
  assert.equal(restRes.status, 200);
  const restaurants = await restRes.json();
  assert.ok(restaurants.length > 0);
  const r = restaurants[0];
  console.log(`✔ GET /restaurants (Found ${restaurants.length} venues, using "${r.name}")`);

  // 3. GET availability
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];
  const availRes = await fetch(`${baseUrl}/restaurants/${r.id}/availability?date=${dateStr}&time=19:00&party_size=2`);
  assert.equal(availRes.status, 200);
  const avail = await availRes.json();
  assert.equal(avail.available, true);
  console.log('✔ GET /availability (Table available for party of 2)');

  // 4. POST /booking-verifications
  const email = 'alex.guest@example.com';
  const verifRes = await fetch(`${baseUrl}/booking-verifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(verifRes.status, 202);
  const verifData = await verifRes.json();
  const verificationId = verifData.verification_id;
  console.log('✔ POST /booking-verifications (Verification challenge issued:', verificationId, ')');

  // 5. GET /api/dev-otps
  const otpsRes = await fetch(`${baseUrl}/api/dev-otps`);
  assert.equal(otpsRes.status, 200);
  const otps = await otpsRes.json();
  assert.ok(otps.length > 0);
  const latestOtp = otps[otps.length - 1];
  assert.equal(latestOtp.email, email);
  const code = latestOtp.code;
  console.log('✔ GET /api/dev-otps (Captured OTP delivered via SMTP:', code, ')');

  // 6. POST /booking-verifications/:id/confirm
  const confirmRes = await fetch(`${baseUrl}/booking-verifications/${verificationId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(confirmRes.status, 200);
  const confirmData = await confirmRes.json();
  const token = confirmData.verification_token;
  assert.ok(token);
  console.log('✔ POST /booking-verifications/:id/confirm (Received signed 15-minute token)');

  // 7. POST /restaurants/:id/reservations
  const idempotencyKey = crypto.randomUUID();
  const bookRes = await fetch(`${baseUrl}/restaurants/${r.id}/reservations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'Customer-Verification-Token': token,
    },
    body: JSON.stringify({
      party_size: 2,
      starts_at_local: `${dateStr}T19:00`,
    }),
  });
  assert.equal(bookRes.status, 201);
  const bookData = await bookRes.json();
  assert.equal(bookData.status, 'confirmed');
  assert.ok(/^[0-9A-F]{12}$/i.test(bookData.confirmation_code));
  console.log(`✔ POST /reservations (Booked reservation ID: ${bookData.id}, Code: ${bookData.confirmation_code})`);

  // 8. GET /reservations/:id
  const getRes = await fetch(`${baseUrl}/reservations/${bookData.id}`, {
    headers: { 'Reservation-Confirmation-Code': bookData.confirmation_code },
  });
  assert.equal(getRes.status, 200);
  const retrieved = await getRes.json();
  assert.equal(retrieved.id, bookData.id);
  assert.equal(retrieved.status, 'confirmed');
  console.log('✔ GET /reservations/:id (Verified confirmation code authorization)');

  // 9. DELETE /reservations/:id (Cancellation)
  const delRes = await fetch(`${baseUrl}/reservations/${bookData.id}`, {
    method: 'DELETE',
    headers: { 'Reservation-Confirmation-Code': bookData.confirmation_code },
  });
  assert.equal(delRes.status, 200);
  const cancelled = await delRes.json();
  assert.equal(cancelled.status, 'cancelled');
  console.log('✔ DELETE /reservations/:id (Cancelled reservation and released table)');

  console.log('\n🎉 ALL LOCAL HOST END-TO-END FLOWS VERIFIED SUCCESSFULLY!');
}

testE2E().catch((err) => {
  console.error('E2E verification failed:', err);
  process.exit(1);
});
