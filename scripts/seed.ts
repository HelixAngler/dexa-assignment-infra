/**
 * Seeds the main database with the demo accounts used by the local stack:
 * three HRD accounts (two issued a temporary password that must be changed
 * at first sign-in) and five employees (one issued a temporary password,
 * one deactivated).
 *
 * Idempotent: every account is upserted on its unique company email, so a
 * rerun leaves exactly one row per account and never creates duplicates.
 *
 * Run from the package root:
 *   node --experimental-strip-types scripts/seed.ts
 *
 * DATABASE_URL_MAIN must point at the main database. A .env file in the
 * package root is read when present; variables already present in the
 * environment always win.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import argon2 from 'argon2';

import { PrismaClient } from '../../identity-service/src/generated/prisma/index.js';

type SeedAccount = {
  name: string;
  email: string;
  position: string;
  phone: string;
  role: 'employee' | 'hrd';
  status: 'active' | 'deactivated';
  mustChangePassword: boolean;
  password: string;
};

const EMPLOYEE_PASSWORD = 'EmployeeDemo!2026';
const HRD_PASSWORD = 'HrdAdmin!2026';
const TEMPORARY_PASSWORD = 'TempFirst!2026';
const TEMPORARY_EMAIL = 'eka@company.com';

const ACCOUNTS: SeedAccount[] = [
  {
    name: 'Ivan R.',
    email: 'ivan@company.com',
    position: 'HRD Manager',
    phone: '+62-811-0000-0001',
    role: 'hrd',
    status: 'active',
    mustChangePassword: false,
    password: HRD_PASSWORD,
  },
  {
    name: 'Sari W.',
    email: 'sari@company.com',
    position: 'HR Manager',
    phone: '+62-817-0000-0007',
    role: 'hrd',
    status: 'active',
    mustChangePassword: true,
    password: TEMPORARY_PASSWORD,
  },
  {
    name: 'Rudi H.',
    email: 'rudi@company.com',
    position: 'HR Staff',
    phone: '+62-818-0000-0008',
    role: 'hrd',
    status: 'active',
    mustChangePassword: true,
    password: TEMPORARY_PASSWORD,
  },
  {
    name: 'Ada L.',
    email: 'ada@company.com',
    position: 'Backend Engineer',
    phone: '+62-812-0000-0002',
    role: 'employee',
    status: 'active',
    mustChangePassword: false,
    password: EMPLOYEE_PASSWORD,
  },
  {
    name: 'Bo M.',
    email: 'bo@company.com',
    position: 'Frontend Engineer',
    phone: '+62-813-0000-0003',
    role: 'employee',
    status: 'active',
    mustChangePassword: false,
    password: EMPLOYEE_PASSWORD,
  },
  {
    name: 'Cleo R.',
    email: 'cleo@company.com',
    position: 'QA Engineer',
    phone: '+62-814-0000-0004',
    role: 'employee',
    status: 'active',
    mustChangePassword: false,
    password: EMPLOYEE_PASSWORD,
  },
  {
    name: 'Dan K.',
    email: 'dan@company.com',
    position: 'Support',
    phone: '+62-815-0000-0005',
    role: 'employee',
    status: 'deactivated',
    mustChangePassword: false,
    password: EMPLOYEE_PASSWORD,
  },
  {
    name: 'Eka P.',
    email: TEMPORARY_EMAIL,
    position: 'Mobile Engineer',
    phone: '+62-816-0000-0006',
    role: 'employee',
    status: 'active',
    mustChangePassword: true,
    password: TEMPORARY_PASSWORD,
  },
];

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

function packageRoot(): string {
  const scriptPath = process.argv[1];
  const base = scriptPath === undefined ? process.cwd() : path.dirname(path.resolve(scriptPath));
  return path.resolve(base, '..');
}

function loadPackageEnv(): void {
  const envPath = path.join(packageRoot(), '.env');
  if (!existsSync(envPath)) {
    return;
  }
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadPackageEnv();

  if (process.env.DATABASE_URL_MAIN === undefined || process.env.DATABASE_URL_MAIN === '') {
    console.error(
      'seed.ts: DATABASE_URL_MAIN is not set; export it or define it in a .env file in the package root.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    for (const account of ACCOUNTS) {
      const passwordHash = await argon2.hash(account.password, HASH_OPTIONS);
      if (!passwordHash.startsWith('$argon2id$')) {
        throw new Error(`password hash for ${account.email} is not an argon2id PHC string`);
      }
      const data = {
        name: account.name,
        position: account.position,
        phone: account.phone,
        role: account.role,
        status: account.status,
        mustChangePassword: account.mustChangePassword,
        authProvider: 'local',
        passwordHash,
      };
      await prisma.employee.upsert({
        where: { email: account.email },
        update: data,
        create: { ...data, email: account.email },
      });
    }

    const rows = await prisma.employee.findMany({
      orderBy: { email: 'asc' },
      select: {
        email: true,
        role: true,
        status: true,
        mustChangePassword: true,
      },
    });
    const passwordByEmail = new Map(ACCOUNTS.map((account) => [account.email, account.password]));

    console.log(`seed.ts: ${rows.length} account(s) present in the main database`);
    for (const row of rows) {
      const password = passwordByEmail.get(row.email) ?? '(unchanged by this script)';
      console.log(
        `  ${row.email} | role=${row.role} | status=${row.status} | mustChangePassword=${row.mustChangePassword} | password=${password}`,
      );
    }
    for (const account of ACCOUNTS) {
      if (account.mustChangePassword) {
        console.log(
          `seed.ts: ${account.email} signs in with the temporary password above and must change it at first sign-in.`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('seed.ts: seeding failed', error);
  process.exit(1);
});
