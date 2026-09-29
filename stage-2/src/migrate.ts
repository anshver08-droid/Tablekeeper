import { migrate, pool } from './db.js';

try {
  await migrate();
  console.log('Migrations applied.');
} finally {
  await pool.end();
}
