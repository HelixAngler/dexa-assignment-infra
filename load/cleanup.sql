-- Removes every fixture artifact of the punch/summary load run.
--
-- Scope: employees carrying the marker address loadtest-*@loadtest.invalid and
-- everything that hangs off them. Nothing else in the database is touched, so
-- demo accounts and other test data survive a run of this script.
--
-- Order matters: attendance rows are deleted first because the foreign key
-- from attendance_sessions to employees refuses to orphan a session, and
-- profile events go before the employee for the same reason.
--
-- Idempotent: with no fixture rows present every statement deletes nothing and
-- the script still succeeds, so it can be run after every attempt.
--
-- Run it against the main database, e.g.
--   docker exec -i infra-postgres-main-1 psql -v ON_ERROR_STOP=1 \
--     -U wfh -d wfh_main -f - < cleanup.sql
-- The matching Redis sign-in sessions are dropped by `node load/seed.js cleanup`,
-- which reads this file after collecting the fixture employee ids.

BEGIN;

DELETE FROM attendance_sessions
WHERE employee_id IN (
  SELECT id FROM employees WHERE email LIKE 'loadtest-%@loadtest.invalid'
);

DELETE FROM profile_change_events
WHERE employee_id IN (
  SELECT id FROM employees WHERE email LIKE 'loadtest-%@loadtest.invalid'
);

DELETE FROM employees
WHERE email LIKE 'loadtest-%@loadtest.invalid';

COMMIT;
