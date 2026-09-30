import { state } from './state';
/* ===== 2867-2919 ===== */
    /* ============================================================
       SITE-WIDE CONFIG — set this ONCE, and every visitor gets
       working YouTube Music search with zero setup on their end.

       1. Go to https://console.cloud.google.com/apis/library/youtube.googleapis.com
       2. Enable "YouTube Data API v3", then create an API key
          (Credentials → Create Credentials → API key).
       3. Restrict the key to "YouTube Data API v3" + your site's
          domain (HTTP referrers) so it can't be used elsewhere.
       4. Paste it below between the quotes.

       Notes for you (not shown to visitors):
       - The free tier is 10,000 units/day; a search costs ~100
         units, so this is shared across ALL visitors (~100
         searches/day total, not per-person). If the site gets
         busy, YouTube results may stop refreshing until the
         quota resets — Audius/iTunes/Deezer keep working either
         way since they don't use this key.
       - Because this is a static page, the key is technically
         visible in the page source to anyone who looks — that's
         normal for a public client-side key and is why step 3
         (domain-restricting it) matters.
       ============================================================ */
    export const AURA_YOUTUBE_API_KEY = '';
    // Jamendo — free, Creative Commons–licensed catalog of full tracks (not
    // previews). Get a free client_id in ~1 minute at
    // https://devportal.jamendo.com and paste it in Settings, or hardcode a
    // site-wide default here. Left blank, this source just stays quiet,
    // same as YouTube above without a key.
    export const AURA_JAMENDO_CLIENT_ID = '';

    // These are your original hardcoded state.songs
    export const defaultSongs = [
      {id:17,title:"One Sun One Moon",artist:"Anirudh Ravichandran",url:"https://desperate-yellow-duzycu4v.edgeone.dev/",img:"https://i.ibb.co/KxcGHFTG/Smart-Select-20260927-013348-Google.jpg",favorite:false},
      {id:7,title:"Ala Bolelo",artist:"Anirudh Ravichandran",url:"https://soviet-green-nft1egcn.edgeone.dev/",img:"https://i.ibb.co/chk9ffkM/Smart-Select-20260922-223458-Google.jpg",favorite:false},
      {id:0,title:"Alaakaa Loova",artist:"Sai Abhyankkar",url:"https://outside-aquamarine-w2u54bqu.edgeone.dev/",img:"https://i.ibb.co/YHZ0rWC/35693.jpg",favorite:false},
      {id:1,title:"Raga The Revenge",artist:"Anirudh Ravichander",url:"https://supporting-olive-d1zmproy.edgeone.dev/",img:"https://i.ibb.co/chsG40Ws/IMG-20260731-WA0008.jpg",favorite:false},
      {id:2,title:"Malare",artist:"Vijay Yesudas",url:"https://alert-blush-nnymigbt.edgeone.dev/",img:"https://i.ibb.co/kCx8ZC7/artworks-000122273241-m3r3k0-t1080x1080.jpg",favorite:false},
      {id:3,title:"Vellarathaaram",artist:"Vineeth Sreenivasan",url:"https://yawning-red-ikwsbqy0.edgeone.dev/",img:"https://i.ibb.co/KpqYTrKj/35736.jpg",favorite:false},
      {id:4,title:"The Life Of Ram",artist:"Pradeep Kumar",url:"https://xerothermic-harlequin-yzadix2r.edgeone.dev/",img:"https://i.ibb.co/8g6SVC1b/MV5-BMGI5-M2-Q4-MDkt-OWVl-OS00-Mz-Vj-LWJl-Nzkt-MWZm-YTkw-OGI2-MDc4-Xk-Ey-Xk-Fqc-Gc-V1.jpg",favorite:false},
      {id:5,title:"Nee Singam Dhan",artist:"Sid Sriram",url:"https://full-maroon-0brst4mx.edgeone.dev/",img:"https://i.ibb.co/hJydbnDc/35741.jpg",favorite:false},
      {id:6,title:"Nallaru Po",artist:"Sai Abhyankkar",url:"https://splendid-harlequin-1i1zkjci.edgeone.dev/",img:"https://i.ibb.co/BHz5VGRz/ab67616d0000b273df173a4e01f3b723805e8890.jpg",favorite:false},
      {id:8,title:"Radhimaa",artist:"Sai Abhyankkar",url:"https://thirsty-amaranth-9yl9ej6z.edgeone.dev/",img:"https://i.ibb.co/RGp74sw6/Radhimaa-From-Think-Indie-Tamil-2026-20260827192132-500x500.jpg",favorite:false},
      {id:9,title:"Kunjikkavil Meghame",artist:"Sooraj Santhosh",url:"https://secondary-aquamarine-vg44gkez.edgeone.dev/",img:"https://i.ibb.co/5hwDJ9Gt/Kunjikkavil-Meghame-From-Aashaan-Malayalam-2025-20251031000053-500x500.jpg",favorite:false},
      {id:10,title:"Thaniye Mizhikal",artist:"Sooraj Santhosh",url:"https://defiant-olive-isdwggd9.edgeone.dev/",img:"https://i.ibb.co/TD9VBj0S/Smart-Select-20260922-224303-Chrome.jpg",favorite:false},
      {id:11,title:"Aaradhike",artist:"Sooraj Santhosh",url:"https://gentle-brown-sfxjlu3z.edgeone.dev/",img:"https://i.ibb.co/Ngq1xZ1g/c4329d5484110fe9de9d584091fed181-600x600x1.jpg",favorite:false},
      {id:12,title:"Aaro Nenjil",artist:"Shaan Rahman",url:"https://silent-indigo-zlcqrfpy.edgeone.dev/",img:"https://i.ibb.co/ccrFkc4M/Smart-Select-20260922-224638-Chrome.jpg",favorite:false},
      {id:13,title:"Raga of Madness",artist:"Anirudh Ravichandran",url:"https://operational-fuchsia-ttqpaydn.edgeone.dev/",img:"https://i.ibb.co/mC7pK69z/Smart-Select-20260922-224808-Chrome.jpg",favorite:false},
      {id:14,title:"Raataan Lambiyan",artist:"Jubin Nautiyal",url:"https://redundant-olive-9anclq5t.edgeone.dev/",img:"https://i.ibb.co/0ynmYy8g/Smart-Select-20260922-224935-Chrome.jpg",favorite:false},
      {id:15,title:"Thuli Thuli",artist:"Yuvan Shankar Raja",url:"https://due-apricot-thosce6o.edgeone.dev/",img:"https://i.ibb.co/wNw9CmsR/Smart-Select-20260922-230639-Chrome.jpg",favorite:false},
      {id:16,title:"Ada Bommale",artist:"Hey Karthik",url:"https://joyous-beige-jtlczdsl.edgeone.dev/",img:"https://i.ibb.co/RGt3fTb6/Smart-Select-20260922-231054-Google.jpg",favorite:false},
      {id:18,title:"Heeriye",artist:"Arijit Singh",url:"https://continued-pink-6lgeo7mk.edgeone.dev/",img:"https://i.ibb.co/0RGW96G5/Heeriye-feat-Arijit-Singh-Hindi-2023-20230928050405-500x500.jpg",favorite:false}
    ];
