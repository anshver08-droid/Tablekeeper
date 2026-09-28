import { insertRestaurant, insertTable } from '../src/app.js';
import { pool } from '../src/db.js';

try {
  const existing = await pool.query("SELECT id FROM restaurants WHERE name = 'TableKeeper Demo' LIMIT 1");
  if (existing.rowCount) {
    console.log(`Demo restaurant already exists: ${existing.rows[0].id}`);
  } else {
    const restaurantId = await insertRestaurant(pool, 'TableKeeper Demo', 'America/New_York');
    await insertTable(pool, restaurantId, 'Table for 2', 2);
    await insertTable(pool, restaurantId, 'Table for 4', 4);
    await insertTable(pool, restaurantId, 'Table for 6', 6);
    console.log(`Seeded TableKeeper Demo: ${restaurantId}`);
  }
} finally {
  await pool.end();
}
