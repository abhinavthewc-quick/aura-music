/* Reviewed name equivalences, not a fuzzy dictionary. Keep short names, bare
   initials and common surnames out: "MG", "Anirudh" or "Rahman" alone do not
   identify a person. New spelling/transliteration aliases need that evidence.
   These rules affect presentation only, never D1 keys or track metadata. */
export interface VerifiedArtist {
  id: string;
  name: string;
  aliases?: readonly string[];
  /* Only these audited, accidentally duplicated natural D1 keys may share a
     display page. An arbitrary/custom profile key remains a distinct owner.
     Both records survive; the resolver uses the most recent cloud profile. */
  equivalentProfileKeys?: readonly string[];
}

export const VERIFIED_ARTISTS: readonly VerifiedArtist[] = [
  {
    id: 'ar-rahman', name: 'A. R. Rahman',
    equivalentProfileKeys: ['a. r. rahman', 'a.r. rahman'],
  },
  { id: 'anirudh-ravichander', name: 'Anirudh Ravichander', aliases: ['Anirudh Ravichandran'] },
  // Full singer name only. The catalogue's bare MG / M G labels stay distinct.
  { id: 'mg-sreekumar', name: 'M. G. Sreekumar' },
  { id: 'sai-abhyankkar', name: 'Sai Abhyankkar', aliases: ['Sai Abhyankar'] },
  { id: 'ilaiyaraaja', name: 'Ilaiyaraaja', aliases: ['Ilaiyaraja', 'Ilayaraja', 'Ilayaraaja'] },
  { id: 'ouseppachan', name: 'Ouseppachan', aliases: ['Ousepachan'] },
  { id: 'vidhu-prathap', name: 'Vidhu Prathap', aliases: ['VidhuPrathap'] },
  {
    id: 'sp-balasubrahmanyam', name: 'S. P. Balasubrahmanyam',
    aliases: ['S. P. Balasubramaniam', 'SP Balasubrahmanyam (SpBaluofficial)'],
  },
  { id: 'imagine-dragons', name: 'Imagine Dragons', aliases: ['ImagineDragons'] },
  { id: 'arctic-monkeys', name: 'Arctic Monkeys', aliases: ['Official Arctic Monkeys'] },
  { id: 'beyonce', name: 'Beyoncé', aliases: ['Beyonce'] },
  { id: 'bjork', name: 'Björk', aliases: ['Bjork'] },
  { id: 'she-and-him', name: 'She & Him', aliases: ['She and Him', 'SheandHimOfficial'] },
];

/* Punctuation can belong to a band's name. Exact cloud profiles protect any
   other compound name too; unknown compounds are only split with independent
   artist evidence. Protect these established names even beside solo credits. */
export const COMPOUND_ARTIST_NAMES: readonly string[] = [
  'Earth, Wind & Fire', 'Simon & Garfunkel', 'Hall & Oates',
  'Daryl Hall & John Oates', 'Kool & The Gang', 'Mumford & Sons',
  'Of Mice & Men', 'Angus & Julia Stone', 'Nick Cave & The Bad Seeds',
  'Tom Petty & The Heartbreakers', 'Bob Marley & The Wailers',
  'Huey Lewis & The News', 'Hootie & The Blowfish', 'The Mamas & The Papas',
  'KC and the Sunshine Band', 'Derek and the Dominos', 'Tyler, The Creator',
];
