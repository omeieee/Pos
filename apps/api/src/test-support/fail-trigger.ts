/**
 * Makes a write fail half way through its transaction, to prove that nothing it emitted is
 * published on rollback (CLAUDE.md rule 6). A temporary BEFORE trigger raises on the rows of
 * `table` that match `when` (SQL over `new`), for the duration of `work` only. Tests only.
 */
import type { Harness } from './harness.ts';

export async function withFailingWrite<T>(
  h: Pick<Harness, 'client'>,
  args: { table: string; op?: 'insert' | 'update'; when: string },
  work: () => Promise<T>,
): Promise<T> {
  const op = args.op ?? 'insert';
  await h.client.query(
    `create or replace function test_fail_write() returns trigger language plpgsql as $$
     begin
       if ${args.when} then raise exception 'test: forced rollback'; end if;
       return new;
     end $$`,
  );
  await h.client.query(
    `create trigger test_fail_write before ${op} on ${args.table}
     for each row execute function test_fail_write()`,
  );
  try {
    return await work();
  } finally {
    await h.client.query(`drop trigger test_fail_write on ${args.table}`);
  }
}
