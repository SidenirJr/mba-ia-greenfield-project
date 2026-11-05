import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

// Dedicated database: the migration runner never touches the shared test DB,
// so the suite is idempotent and order-independent (tables, enums and the
// `migrations` table all disappear with the database).
const MIGRATIONS_TEST_DB = 'streamtube_migrations_test';

describe('Database migrations (integration)', () => {
  let adminDataSource: DataSource;
  let dataSource: DataSource;

  beforeAll(async () => {
    adminDataSource = createTestDataSource([], { synchronize: false });
    await adminDataSource.initialize();
    await adminDataSource.query(
      `DROP DATABASE IF EXISTS "${MIGRATIONS_TEST_DB}" WITH (FORCE)`,
    );
    await adminDataSource.query(`CREATE DATABASE "${MIGRATIONS_TEST_DB}"`);

    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken],
      {
        database: MIGRATIONS_TEST_DB,
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await adminDataSource.query(
      `DROP DATABASE IF EXISTS "${MIGRATIONS_TEST_DB}" WITH (FORCE)`,
    );
    await adminDataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);

    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'verification_tokens_type_enum'`,
    );
    expect(enums).toHaveLength(0);
  });
});
