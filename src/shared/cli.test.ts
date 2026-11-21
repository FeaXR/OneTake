import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { freeName, parseCli, parseDuration } from './cli.ts';

const parse = (...args: string[]) => parseCli(args, '/home/user', posix.resolve);

test('durations in seconds, units or clock form', () => {
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('45m'), 2700);
  assert.equal(parseDuration('45min'), 2700);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('1h 30m 10s'), 5410);
  assert.equal(parseDuration('1.5h'), 5400);
  assert.equal(parseDuration('1:30'), 90);
  assert.equal(parseDuration('1:30:00'), 5400);
  for (const bad of ['', '0', '0s', 'abc', '1:75', '-5', '5x', 'h', '1:2:3:4']) assert.equal(parseDuration(bad), null, bad);
});

test('a recording with every option, in both spellings', () => {
  assert.deepEqual(parse('--record', '--dir', 'rec', '--name=Sunday', '--duration', '1h', '--input=Scarlett'), {
    command: { kind: 'record', dir: '/home/user/rec', name: 'Sunday.wav', durationSec: 3600, input: 'Scarlett' },
  });
});

test('a recording with no options goes to the current folder, until stopped', () => {
  assert.deepEqual(parse('--record'), { command: { kind: 'record', dir: '/home/user' } });
});

test('other arguments are left alone', () => {
  assert.deepEqual(parse('.', '--remote-debugging-port=9222', 'take.wav'), { command: null });
  assert.deepEqual(parse('--no-sandbox', '--record', '--name', 'a.WAV'), { command: { kind: 'record', dir: '/home/user', name: 'a.WAV' } });
});

test('stop and help', () => {
  assert.deepEqual(parse('--stop'), { command: { kind: 'stop' } });
  assert.deepEqual(parse('--help'), { command: { kind: 'help' } });
});

test('mistakes are reported', () => {
  for (const args of [
    ['--record', '--duration'],
    ['--record', '--duration', 'soon'],
    ['--record', '--name', '--dir', 'x'],
    ['--record', '--name', 'a/b'],
    ['--record', '--name', '  '],
    ['--record', '--stop'],
    ['--stop', '--name', 'x'],
    ['--duration', '5m'],
  ]) assert.ok('error' in parse(...args), args.join(' '));
});

test('an existing name gets the first free number', () => {
  assert.equal(freeName('a.wav', ['b.wav']), 'a.wav');
  assert.equal(freeName('a.wav', ['A.WAV']), 'a (2).wav');
  assert.equal(freeName('a.wav', ['a.wav', 'a (2).wav', 'a (3).WAV']), 'a (4).wav');
});
