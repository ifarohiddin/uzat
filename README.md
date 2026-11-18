# Uzat — bir bosishda ekran ulashish

Kompyuter ekranini shu tarmoqdagi qurilmaga jonli uzatadi. Qabul qiluvchi telefon, Android head unit, televizor yoki boshqa kompyuter bo'lishi mumkin. Qabul qiluvchi qurilmaga hech narsa o'rnatish shart emas, oddiy brauzer yetarli. Ruxsat berilsa, o'sha qurilmaning ekraniga tegib kompyuterni boshqarish ham mumkin.

## Ishga tushirish

`Uzat.cmd` ni ikki marta bosing (birinchi marta `npm install` o'zi bajariladi).

Birinchi ochishda Windows Firewall ruxsat so'raydi. **Private** va **Public** tarmoqlarning ikkalasini ham belgilab, **Allow** ni bosing. Windows hotspot tarmog'i ko'pincha "Public" deb hisoblanadi.

## O'rnatish

`dist/` papkasida ikki xil fayl bor:

- `Uzat-Setup-1.0.0.exe` — o'rnatgich. U ish stoliga va Start menyusiga yorliq qo'yadi hamda Firewall ruxsatini o'zi qo'shadi.
- `Uzat-1.0.0-portable.exe` — o'rnatmasdan ishlaydigan versiya. Bunda Firewall ruxsatini birinchi ishga tushirishda qo'lda berish kerak.

Ilova raqamli imzolanmagan. Shuning uchun Windows "Windows protected your PC" deb ogohlantirsa, **More info → Run anyway** ni bosing.

Qayta build qilish uchun: `npm run dist`.

## Android qurilmaga ulashish — 1-usul: DLNA (eng oson)

Uzat tarmoqdagi DLNA qurilmalarni (head unit, televizor) o'zi topib, ro'yxatda 📺 belgisi bilan ko'rsatadi. Qurilmani tanlab **Ulashish** ni bossangiz, ekran qurilmada o'zi ochiladi, u yerda hech narsa qilish kerak emas.

- Video MP4 (H.264) formatida uzatiladi. AndroidAP-1708 da sinalgan: MP4 ishlaydi, MKV ishlamaydi.
- Kechikish 1–3 soniya bo'ladi, chunki qurilmadagi pleyer videoni buferga yig'ib o'ynatadi.
- Qurilmadan boshqarish **ishlamaydi**. Buning uchun 2-usuldan foydalaning.

## Android qurilmaga ulashish — 2-usul: brauzer (tez + qo'l bilan boshqarish)

1. Uzat'da **🌐 Brauzer** ni tanlang, keyin **Ulashish** ni bosing.
2. Kartada manzil (`192.168.137.1:8090`) va 4 xonali **PIN** chiqadi.
3. Qurilmada brauzerni oching, shu manzilni yozing va PIN ni kiriting.
4. Qurilmadan boshqarish uchun Uzat oynasining pastidagi **Boshqaruv** tugmasini yoqing.

Qurilmadagi sahifa PIN ni eslab qoladi. Keyingi safar sahifa ochiq tursa, kompyuterda ulashish boshlanishi bilan ekran o'zi chiqadi.

### Qurilmadan boshqarish

| Qurilmada | Kompyuterda |
|---|---|
| Bosish | Chap tugma bilan bosish |
| Ikki marta bosish | Ikki marta bosish |
| Bosib turish (0,6 s) | O'ng tugma bilan bosish |
| Bosib sudrash | Sudrash / belgilash |
| Ikki barmoq bilan surish | Aylantirish (scroll) |
| ⌨ tugmasi | Matn yozish, ⌫, ↵ |

Boshqaruv boshlanishda **o'chiq** turadi va faqat **butun ekran** ulashilganda ishlaydi. Administrator huquqi bilan ochilgan oynalarni Windows boshqarishga yo'l qo'ymaydi.

## Boshqa usullar

- **Uzat ↔ Uzat.** Ikkinchi kompyuterda ham Uzat ochiq bo'lsa, u ro'yxatda nomi bilan chiqadi. Tanlab **Ulashish** ni bossangiz, unda "Ko'rish / Rad etish" so'rovi chiqadi.

## Nega qotmaydi

- Uzatish WebRTC orqali, kompyuterdan qurilmaga to'g'ridan-to'g'ri boradi, server orqali o'tmaydi.
- Ekran videokartada (NVIDIA / Intel / AMD) H.264 formatiga kodlanadi, shuning uchun protsessor yuklanmaydi.
- Tarmoq sekinlashsa, sifat o'zi moslashadi. Lokal tarmoqda kechikish odatda 15–30 ms.
- Sifat rejimlari: **Tez** (720p, 60 fps), **Muvozanat** (1080p, 60 fps), **Aniq** (asl o'lcham, 30 fps).
- Teginishlar WebRTC ma'lumot kanali orqali qaytadi. Ularni kompyuterdagi kichik yordamchi (`native/input.cs`) Windows SendInput orqali bajaradi.

## Tuzilishi

| Fayl | Vazifasi |
|---|---|
| `main.js` | Electron: oynalar, ekran tanlash, sessiyalar, boshqaruv |
| `core/web.js` | Brauzer ko'ruvchilari uchun HTTP server, PIN va signal almashish |
| `core/input.js`, `native/input.cs` | Sichqoncha va klaviaturani boshqaruvchi yordamchi (birinchi ishga tushishda kompilyatsiya qilinadi) |
| `core/discovery.js`, `core/signal.js` | Uzat ↔ Uzat: qurilmalarni topish va signal almashish |
| `core/dlna.js` | DLNA qurilmaga "o'ynat / to'xtat" buyruqlarini yuborish |
| `src/` | Uzat oynasi va ko'rish oynasi |
| `web/` | Qurilma brauzerida ochiladigan ko'rish sahifasi |

## Sinovlar

```
npm run e2e       # ikkita Uzat: so'rov → qabul → WebRTC video (o'lcham, fps, kodek)
npm run e2e-web   # brauzer rejimi + boshqaruv: sahifa PIN bilan ulanadi, sichqoncha koordinatalari tekshiriladi
```

## Xavfsizlik

- Brauzer ko'ruvchilari faqat har safar yangidan yaratiladigan PIN bilan ulana oladi.
- Boshqaruv faqat Uzat oynasida qo'lda yoqilganda ishlaydi.
- Video WebRTC tomonidan shifrlanadi (DTLS-SRTP). Sahifa va PIN esa oddiy HTTP orqali uzatiladi, shuning uchun faqat ishonchli tarmoqda ishlating.
