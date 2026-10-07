import { expect, test } from '@playwright/test';

test('the test runner reports plain assertions', () => {
  expect(1).toBe(1);
});
