# Little Studio

Çocuk hikâyesinden dikey video üreten bir panel. Senaryo ve Veo klipleri Gemini web üzerinden gider; montaj sunucuda FFmpeg ile yapılır. İstersen biten video YouTube hesabına yüklenir.

Google **AI Ultra** aboneliğiyle daha rahat çalışır. Ultra, Gemini web tarafında daha yüksek Veo ve sohbet limiti verir. Ücretsiz veya düşük katmanda sık “too many requests” ve oturum düşmesi görülebilir. Ultra bir garanti değildir; Google oturumu yine sürebilir. Web otomasyonu Google’ın koşullarına takılabilir.

## Ne yapar

- Hikâye yazar veya boş fikri Gemini ile doldurur
- Her sahne için ayrı sohbette Veo klibi ister
- Klipleri altyazılı dikey videoda birleştirir
- YouTube OAuth ile yükleyebilir
- Üretim kuyruğu, bütçe sınırı ve panel parolası vardır

## Kimlik bilgisi yok

Depoda API anahtarı, OAuth sırrı, YouTube tokeni, Gemini çerezi ve panel parolası yoktur. Bunları kendi `.env` dosyanda ve panelden gir.

```bash
cp .env.example .env
```

`.env` içine uzun bir `STUDIO_PASSWORD` yaz. Gemini API kullanacaksan `GEMINI_API_KEY` ekle. Web kanalı için anahtar yerine `deploy/gemini-login.mjs` ile aldığın `gemini-session.json` dosyasını sunucunun veri klasörüne koy. O dosyayı paylaşma.

YouTube için Google Cloud’da bir OAuth istemcisi aç. Yönlendirme adresi: `https://SENIN-PANELIN/api/youtube/callback`. İstemci kimliği ve sırrı panele yazılır, repoya değil.

## Çalıştırma

Node.js 24 ve FFmpeg gerekir.

```bash
npm install
npx playwright install chromium
npm test
npm start
```

Panel: http://127.0.0.1:3210

Üretim kanalını panelden `web` seçersen hikâye ve video Gemini sitesine gider. `api` seçersen ücretli Gemini API kullanılır.

## Dizin

```text
server.mjs          HTTP paneli
lib/geminibot.mjs   Gemini web (Playwright)
lib/google.mjs      Gemini API
lib/worker.mjs      kuyruk
lib/youtube.mjs     OAuth yükleme
public/             panel arayüzü
deploy/             kurulum ve gemini giriş betiği
```

Veriler `data/` altında kalır. Bu klasör `.gitignore` içindedir.
