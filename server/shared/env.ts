import path from 'path';
import dotenv from 'dotenv';

dotenv.config({
  path: [path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env')],
  override: true,
  quiet: true,
});
