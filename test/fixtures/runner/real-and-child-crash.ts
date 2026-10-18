// One child crash beside one real failure: the real failure wins, no rerun.
import assert from 'node:assert/strict';
import { test } from 'node:test';
test('a child crashed', () => { assert.equal(3221225477, 2); });
test('a real failure', () => { assert.equal(1, 2); });
