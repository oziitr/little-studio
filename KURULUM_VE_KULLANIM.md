# Little Studio kullanımı

## İlk bağlantı

Panel: **https://panel.example** (DNS ve sertifika tamamlandığında).
Giriş parolası sunucudaki `/etc/little-studio.env` dosyasında `STUDIO_PASSWORD` alanındadır. Parolayı veya API anahtarını sohbete göndermeyin.

## Google

1. Google AI Studio'da Gemini API projesi ve anahtarı oluşturun. Veo için hesabınızın faturalandırması ve model erişimi açık olmalı.
2. Panel → Bağlantılar → Gemini API anahtarını girin. Model adlarını hesabınızda erişebildiğiniz modellerle eşleştirin.
3. Görsel/metin/video birim ücretlerini kendi hesabınızdan kontrol edin. Paneldeki fiyatlar başlangıç tahminidir, resmi tarife değildir.
4. Günlük/aylık/iş başına limitleri belirleyin; fiyat onayını ve ücretli üretimi açıp kaydedin.
5. Bir proje oluşturun. Önce senaryo, sonra tek sahne görseli ve tek Veo klibi ile gerçek erişimi sınayın.

Üretim için Flow aboneliğinin API kredisi sağladığını varsaymayın. Bu uygulama Google API kullanır.

## YouTube

1. Google Cloud projesinde YouTube Data API v3'ü etkinleştirin.
2. OAuth izin ekranını hazırlayın. Test modundaysa kendi Google hesabınızı test kullanıcısı ekleyin.
3. Web uygulaması OAuth istemcisi oluşturun. Redirect URI tam olarak `https://panel.example/api/youtube/callback` olmalı.
4. Panel bağlantılarında OAuth istemci kimliği ve sırrını kaydedin. YouTube hesabını bağla ile Google izin akışını tamamlayın.
5. Varsayılan yükleme gizlidir. Herkese açık/zamanlanmış yayın için ayarı açıkça etkinleştirin.

YouTube, denetlenmemiş API projelerinden yüklenen videoları gizliye sınırlayabilir. Uygulama bir video kimliği almasını herkese açık yayın garantisi olarak göstermez. OAuth test uygulamalarında token süresi dolabilir; yeniden bağlantı gerekebilir.

## Üretim

- Proje: fikir, karakter, yaş, İngilizce/Türkçe, görsel tarz.
- Referans: PNG/JPEG karakter görseli yüklenebilir. Değişirse mevcut sahne çıktıları projeden ayrılır; dosyalar silinmez.
- Sahne: 8 saniyelik klipler. Görsel, hareket, konuşma ayrı düzenlenebilir.
- Senaryoyu yaz: dört sahne oluşturur.
- Tümünü üret: sahne yoksa senaryo; ardından eksik görseller, Veo klipleri ve montaj.
- Videoyu monte et: mevcut klipleri 720×1280, 24fps H.264/AAC olarak birleştirir.
- Altyazı: sahne metni sekiz saniye gösterilir; kelime zamanlaması yoktur.
- Veo'nun kendi ses üretimi kullanılır; ayrı profesyonel TTS entegrasyonu yoktur. Üretilen konuşmayı dinleyerek kontrol edin.
- YouTube: gizli/liste dışı/herkese açık, isteğe bağlı gelecek yayın tarihi.
- Otomasyon: şablon karakter/fikirden yeni hikâyeler, en az 6 saat aralık, isteğe bağlı otomatik yükleme. Yeni hikâyelerin tamamen benzersiz olması salt rastgele seed ile garanti edilmez.

## Kontrollerin sınırları

- Metin üzerinde AI içerik kontrolü var. Bu görselleri/sesi kusursuz denetleyen bir moderasyon sistemi değildir.
- Bütçe kontrolü tahmini rezervlere dayanır; sağlayıcının gerçek faturasını okumaz. Belirsiz ücretleri hesaba katmak için hata durumunda rezerv otomatik iade edilmez.
- Kalıcı Veo operation ve YouTube upload oturumları tekrar ücret/yükleme riskini azaltır. API kabulü ile işlem kimliğinin kaydedilmesi arasında bağlantı koparsa sistem otomatik yeniden üretmez.
- Görsel kalite, karakter tutarlılığı, konuşma doğruluğu ve çocuklara uygunluk ilk çıktılarda insan tarafından kontrol edilmelidir.
- Çocuklara özel ve sentetik içerik alanları yüklemede açık gönderilir.
- Eski çıktılar otomatik silinmez. Disk eşiği üretimi durdurur; arşiv yönetimi operatöre aittir.

## Sunucu

Plesk'teki diğer sitelerden ayrı `little-studio.service`, localhost:3210.

```bash
systemctl status little-studio
journalctl -u little-studio -n 100 --no-pager
```

Uygulama: `/opt/little-studio/current`
Kalıcı veriler: `/var/lib/little-studio`
Ortam: `/etc/little-studio.env`
Node 24 uygulamaya özel dizinde; sunucunun mevcut Node 20 kurulumu değiştirilmez.
CPU limiti 2 çekirdek, bellek limiti 4 GB. Plesk SSL yönlendirmesi yalnız yeni alt alan adına uygulanır.

Yedekleme için `deploy/backup.mjs` SQLite backup API'sini kullanır; `vault.key` ve medya birlikte korunmalı. Veritabanının şifresini açan anahtar aynı sunucudadır; bu mekanizma root erişimine karşı koruma değildir. Tam tutarlı medya yedeği için üretim kuyruğunun boş olmasını bekleyin.

```bash
DATA_DIR=/var/lib/little-studio /opt/little-studio/runtime/node-v24.18.1-linux-x64/bin/node /root/little-studio-source/deploy/backup.mjs /root/little-studio-backups/YEDEK_ADI
```

SSH için oluşturulan özel anahtar yalnız yerel `data/ssh/studio_deploy` dosyasında. Bu dosyayı veya `data/` klasörünü paylaşmayın. Sunucu `authorized_keys` içinde `little-studio-deploy` açıklamasıyla kayıtlıdır; görev sonrası erişimi kaldırmak isterseniz yalnız bu satırı kaldırın, diğer anahtarları koruyun.
