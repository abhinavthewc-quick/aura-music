import { expect, test } from '@playwright/test';
import { hfFileUrl, normalizeHfArtworkUrl } from '../../src/core/catalog';

test('legacy artwork URLs move to covers without corrupting filenames or query parameters', () => {
  for (const name of ["Artist - Sita's Song [abcdefghijk].webp", 'பாட்டு + 10% ?#& (%2E%2E).jpg', 'Artist - Song.PNG']) {
    const old = hfFileUrl(name) + '?download=true#art';
    const current = hfFileUrl(`covers/${name}`) + '?download=true#art';
    expect(normalizeHfArtworkUrl(old)).toBe(current);
    expect(normalizeHfArtworkUrl(current)).toBe(current);
  }
});

test('custom/local artwork, other buckets, nested images and audio paths retain their meaning', () => {
  for (const value of ['/aura-logo.png', 'blob:https://aura.test/art', 'data:image/png;base64,aGVsbG8=',
    'https://images.example.com/song.webp', 'https://huggingface.co/buckets/other/music/resolve/song.webp',
    hfFileUrl('albums/song.webp'), hfFileUrl('originals/song.opus'),
    'https://huggingface.co/buckets/Angelrider/sonora/resolve/album%2Fsong.webp',
    'https://huggingface.co/buckets/Angelrider/sonora/resolve/%ZZ.webp']) {
    expect(normalizeHfArtworkUrl(value)).toBe(value);
  }
});

