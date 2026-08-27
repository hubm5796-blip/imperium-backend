import { describe, expect, it } from 'vitest';
import { isSafeArtifactName } from '../api/expansion/aiGallery.js';

/**
 * The artifact-name whitelist is the only thing keeping ?name= inside
 * plugins/ImperiumMC/ai — these tests pin the traversal vectors shut.
 */
describe('isSafeArtifactName', () => {
  it('accepts the artifacts the aidev tools actually write', () => {
    for (const ok of [
      'face.png', 'view.png', 'pano_N.png', 'top.png', 'tex.png', 'item.png', 'inv.png',
      'tree.txt', 'tap.txt', 'watch.txt', 'tiles.txt', 'worlds.txt', 'suggest.txt',
      'sim.txt', 'face.txt', 'view.txt', 'scan.txt', 'pano.txt', 'a1-b2.txt', 'My.Log.1.log',
    ]) {
      expect(isSafeArtifactName(ok), ok).toBe(true);
    }
  });

  it('rejects traversal and absolute/relative paths', () => {
    for (const bad of [
      '../config.yml', '..%2fconfig.yml', '/etc/passwd', 'ai/face.png', './face.png',
      'a/b/c.png', 'C:\\windows\\x.png', '..', 'face.png/', 'subdir/../../keys.yml',
    ]) {
      expect(isSafeArtifactName(bad), bad).toBe(false);
    }
  });

  it('rejects missing names, odd characters, unknown extensions and oversized names', () => {
    for (const bad of [undefined, '', '.png', 'face', 'face.php', 'face.png.jpg.exe', 'naïve.png', 'a b.png', 'x'.repeat(101) + '.png']) {
      expect(isSafeArtifactName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
