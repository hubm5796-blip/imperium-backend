import { describe, expect, it } from 'vitest';
import { scrubCrashText } from '../utils/crashTextRedaction.js';

/**
 * Scrubber unit tests for the backend half of the shared crash-report
 * redaction rules (src/utils/crashTextRedaction.ts). The fixture mirrors the
 * launcher half's fixture (ImperiumLauncher test/redact.test.js) so both
 * implementations prove the same rule set — pattern-for-pattern identical,
 * mirrored comment blocks in both files.
 */
const FIXTURE_CRASH_REPORT = [
  '---- Minecraft Crash Report ----',
  '// Why did you do that?',
  'Time: 2026-10-21 08:15:30 CET',
  'Description: Rendering overlay',
  '',
  'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll',
  '\tat org.lwjgl.system.Library.loadSystem(Library.java:177)',
  '\tat net.minecraft.client.main.Main.main(Main.java:1291)',
  '',
  '-- System Details --',
  'Operating System: Windows 11 (amd64) version 10.0.26200',
  'Java Version: 17.0.12, Eclipse Adoptium',
  'Fabric Mods:',
  '    fabric-api 0.116.0+1.21',
  '    sodium 0.6.13+mc1.21.4',
  'Launched Version: RomanicaClient 0.2.0-beta.24',
  'Game Dir: C:\\Users\\MylesThePro\\AppData\\Roaming\\Romanica\\instances\\main',
  'Resource Dir: C:/Users/MylesThePro/AppData/Roaming/Romanica/resources',
  'Mod Path: %APPDATA%\\Romanica\\instances\\main\\mods\\sodium.jar',
  'Profile Root: /Users/MylesThePro/Library/Application Support/Romanica',
  'Server Dir: /home/myles/romanica-server',
  '',
  '-- Auth debug (echoed by a chatty library) --',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'Renewing with refresh_token=8f14e45fceea167a5a36dedd4bea2543ca9a',
  'X-Session header: session token 3f2b9c01a4d8e67f5a0b2c3d4e5f6071 accepted',
  'Microsoft login: client_secret: dZmVkYjE2YTAtYTNlNS00YTNhLTkyZTctYjNkMjg0Y2E1Zjc4',
  'Previous identity was eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3MjM5MjY0MDB9.k2Z9Xx8mQ1vJn3LpQ7wRtYuIOLMbHcSaVd5NfGeE1sA here',
  '',
].join('\n');

describe('scrubCrashText — usernames and profile paths', () => {
  it('scrubs the username from every path spelling in the fixture', () => {
    const scrubbed = scrubCrashText(FIXTURE_CRASH_REPORT);
    expect(scrubbed).not.toContain('MylesThePro');
    expect(scrubbed).not.toContain('myles');
    expect(scrubbed).toContain('C:\\Users\\REDACTED\\AppData\\Roaming\\Romanica\\instances\\main');
    expect(scrubbed).toContain('C:/Users/REDACTED/AppData/Roaming/Romanica/resources');
    expect(scrubbed).toContain('/Users/REDACTED/Library/Application Support/Romanica');
    expect(scrubbed).toContain('/home/REDACTED/romanica-server');
    expect(scrubbed).toContain('%REDACTED%\\Romanica\\instances\\main\\mods\\sodium.jar');
    expect(scrubbed).not.toContain('%APPDATA%');
  });

  it('handles drive letters, lowercase users, quoted JSON, trailing punctuation and URLs', () => {
    expect(scrubCrashText('D:\\users\\bob\\mods\\x.jar')).toBe('D:\\users\\REDACTED\\mods\\x.jar');
    expect(scrubCrashText('loading "C:\\Users\\Ann-Marie.S\\config.json" now')).toBe(
      'loading "C:\\Users\\REDACTED\\config.json" now',
    );
    expect(scrubCrashText('path C:\\Users\\john: failed')).toBe('path C:\\Users\\REDACTED: failed');
    // Already redacted: unchanged.
    expect(scrubCrashText('C:\\Users\\REDACTED\\AppData\\Roaming')).toBe('C:\\Users\\REDACTED\\AppData\\Roaming');
    // A URL path is not a home directory.
    expect(scrubCrashText('see https://example.com/home/page for details')).toBe(
      'see https://example.com/home/page for details',
    );
  });
});

describe('scrubCrashText — tokens and secrets', () => {
  it('scrubs bearer, labelled and bare-JWT credentials from the fixture, keeping labels', () => {
    const scrubbed = scrubCrashText(FIXTURE_CRASH_REPORT);
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubbed).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
    expect(scrubbed).not.toContain('8f14e45fceea167a5a36dedd4bea2543ca9a');
    expect(scrubbed).not.toContain('3f2b9c01a4d8e67f5a0b2c3d4e5f6071');
    expect(scrubbed).not.toContain('dZmVkYjE2YTAtYTNlNS00YTNhLTkyZTctYjNkMjg0Y2E1Zjc4');
    expect(scrubbed).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(scrubbed).toContain('Authorization: Bearer [REDACTED]');
    expect(scrubbed).toContain('refresh_token=[REDACTED]');
    expect(scrubbed).toContain('session token [REDACTED] accepted');
    expect(scrubbed).toContain('client_secret: [REDACTED]');
    expect(scrubbed).toContain('Previous identity was [REDACTED] here');
  });

  it('covers the separator forms and respects the 16-char floor', () => {
    expect(scrubCrashText('password=hunter2hunter2hunter2')).toBe('password=[REDACTED]');
    expect(scrubCrashText('"access_token": "c3VwZXJzZWNyZXR2YWx1ZTEyMzQ1"')).toBe('"access_token": "[REDACTED]"');
    expect(scrubCrashText('api-key 0123456789abcdef0123456789abcdef rejected')).toBe('api-key [REDACTED] rejected');
    expect(scrubCrashText('Authorization: bearer abcdefghijklmnopqrstuvwxyz123456')).toBe(
      'Authorization: bearer [REDACTED]',
    );
    // Short values below the floor are ordinary words, not secrets.
    expect(scrubCrashText('password incorrect, try again')).toBe('password incorrect, try again');
  });
});

describe('scrubCrashText — diagnostic value is kept', () => {
  it('keeps stack frames, mod ids, error text, bare digests, UUIDs and addresses', () => {
    const scrubbed = scrubCrashText(FIXTURE_CRASH_REPORT);
    expect(scrubbed).toContain('\tat org.lwjgl.system.Library.loadSystem(Library.java:177)');
    expect(scrubbed).toContain('\tat net.minecraft.client.main.Main.main(Main.java:1291)');
    expect(scrubbed).toContain('java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll');
    expect(scrubbed).toContain('fabric-api 0.116.0+1.21');
    expect(scrubbed).toContain('sodium 0.6.13+mc1.21.4');
    expect(scrubbed).toContain('RomanicaClient 0.2.0-beta.24');

    const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(scrubCrashText(`sha256 ${digest}`)).toBe(`sha256 ${digest}`);
    const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
    expect(scrubCrashText(`--uuid ${uuid}`)).toBe(`--uuid ${uuid}`);
    expect(scrubCrashText('connected to 198.51.100.7:25565')).toBe('connected to 198.51.100.7:25565');
  });

  it('is idempotent — a second pass is a no-op', () => {
    const once = scrubCrashText(FIXTURE_CRASH_REPORT);
    expect(scrubCrashText(once)).toBe(once);
  });

  it('passes empty input through', () => {
    expect(scrubCrashText('')).toBe('');
  });
});
