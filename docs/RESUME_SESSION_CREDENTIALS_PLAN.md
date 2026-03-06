# Resume Session – Credential Yükleme Implementasyon Planı

## Problem
Önceki bir session’dan devam edildiğinde (kullanıcı listeden session seçip Start’a bastığında) o session’a ait credential listesi API’den yüklenmiyor. `containerCredentials` boş veya storage’daki eski session’a ait kalıyor. Sonuç:
- Credential header senkronu (Cookie vb. değişince PATCH) çalışmıyor.
- Ingest istekleri doğru `credential_id` ile gönderilmiyor.

## Hedef
- Start (yeni veya mevcut session) ve extension restart sonrası state restore sırasında, **sessionID varsa** o session’ın credential’larını API’den alıp `containerCredentials` ile senkron hale getirmek.
- Mevcut akışları bozmamak: yeni session, credential ekleme/silme, header sync, ingest.

---

## Credential senkron yönü (önemli)

- **Kaynak: tarayıcı.** Güncel credential bilgisi (Cookie, Authorization vb.) her zaman tarayıcıdaki isteklerden okunur.
- **Hedef: sunucu.** Tarayıcıdaki bilgi güncellenmişse (login, cookie değişimi vb.) **sadece sunucu güncellenir**; sunucudaki değerler eklentiyi ezmez.
- **Sunucudan gelen veri** sadece şunlar için kullanılır:
  - **Eşleme:** Hangi container’ın hangi `credential_id` ile eşlendiği (liste ve ID’ler).
  - **Karşılaştırma bazı:** Sunucudaki `headers` alanı, “son bilinen header’lar” olarak `lastHeaders`’a yazılır; böylece ilk istekte “tarayıcıdaki header’lar buna göre değişti mi?” kontrolü yapılır. Değiştiyse **tarayıcıdaki güncel header’lar PATCH ile sunucuya gönderilir.**
- **Özet:** Eklenti, sunucudaki credential değerleriyle kendi state’ini ezmez; sadece eşleme ve “değişiklik var mı?” karşılaştırması için kullanır. Güncel değer her zaman tarayıcıdan alınır ve gerekirse sunucuya yazılır.

---

## 1. Ortak yardımcı fonksiyon (background.js)

**Amaç:** API’den sadece **eşleme ve karşılaştırma bazı** alınır; güncel credential değeri tarayıcıda kalır, sunucu eklentiyi ezmez. Liste, `containerCredentials` formatına çevrilip bellek ve storage’a yazılır.

- **İsim önerisi:** `applySessionCredentials(sid)` veya `loadAndApplySessionCredentials(sid)`.
- **Yapılacaklar:**
  - `loadSessionCredentials(sid)` ile `GET /session/{sid}/web/credentials` çağrısı (zaten var).
  - Dönen her `cred` için: `cred.container_id` varsa  
    `containerCredentials[cred.container_id] = { credentialID: cred.id, label: cred.label, lastHeaders: cred.headers || {} }`.  
    Buradaki `lastHeaders`, **sunucudaki son bilinen değer**; sadece “tarayıcı değişti mi?” diye karşılaştırma için kullanılır. İlk istekte tarayıcıdaki header’lar buna göre kontrol edilir; fark varsa mevcut akıştaki gibi **tarayıcı → sunucu** PATCH yapılır.
  - Bu session’a geçerken `containerCredentials` sıfırlanıp sadece API sonucu ile doldurulur (önceki session’dan kalan eşleme kalmaz).
  - `browser.storage.local.set({ containerCredentials })` ile kaydetmek.
- **Dönüş:** Promise; hata durumunda boş liste uygula, log at, capture yine başlasın (reject zorunlu değil).

**Senkron yönü:** Bu fonksiyon sunucudan **sadece eşleme + lastHeaders (karşılaştırma bazı)** alır. Güncel credential’ın tarayıcıda olup sunucuya yazılması, mevcut `onBeforeSendHeaders` → `headersChanged` → `syncCredentialHeaders` akışıyla yapılır; bu akış değişmez.

---

## 2. "start" message handler değişikliği (background.js)

**Mevcut:**  
`start` gelince sadece `scope`, `serverUrl` set edilip `startCapture({ sessionID: message.sessionID })` çağrılıyor; `sendResponse({ ok: true, capturing: true })` senkron dönüyor.

**Yeni akış:**

- `message.sessionID` **yoksa** (pratikte popup hep sessionID gönderiyor ama güvenlik için):
  - Mevcut gibi: `startCapture({ sessionID: null })`, `sendResponse(...)`.
- `message.sessionID` **varsa**:
  - Async yanıt kullan: listener’dan `return true` dön (kanal açık kalsın).
  - Önce `applySessionCredentials(message.sessionID)` çağır (await veya .then).
  - Başarılı bitince: `startCapture({ sessionID: message.sessionID })`, `sendResponse({ ok: true, capturing: true })`.
  - Hata (ağ/sunucu) durumunda: log + `containerCredentials = {}` ve storage güncelle, yine `startCapture({ sessionID: message.sessionID })` + `sendResponse({ ok: true, capturing: true })` (capture başlasın, credential’sız devam etsin).

Böylece hem “yeni oluşturulmuş session” (API’de henüz credential yok → boş liste) hem “önceki session’dan devam” (API’de credential’lar var → liste dolar) doğru işlenir.

---

## 3. init() değişikliği (background.js)

**Mevcut:**  
Storage’dan `isCapturing`, `activeSessionID`, `containerCredentials` okunuyor; `isCapturing && activeSessionID` ise doğrudan `startCapture({ sessionID: data.activeSessionID })` çağrılıyor. Credential listesi sadece storage’daki eski değer.

**Yeni akış:**

- `data.isCapturing && data.activeSessionID` ise:
  - Önce `await loadSessionCredentials(data.activeSessionID)` (veya yeni `applySessionCredentials(data.activeSessionID)`) ile API’den güncel listeyi al.
  - Sonucu `containerCredentials` ve storage’a uygula (applySessionCredentials zaten storage’ı da yazar).
  - Ardından `startCapture({ sessionID: data.activeSessionID })`.
- Hata durumunda (sunucu kapalı vb.): mevcut storage’daki `containerCredentials` ile devam edip `startCapture` çağrılabilir (offline tolerance).

Böylece extension yeniden başladığında da aktif session’ın credential’ları sunucudan senkron olur.

---

## 4. attachSession (background.js)

- İsteğe bağlı: Credential yükleme kısmı `applySessionCredentials(message.sessionID)` çağrısına indirgenebilir; böylece tek mantık kalır.
- Davranış değişmemeli: session attach edilir, credential’lar yüklenir, yanıt aynı kalır.

---

## 5. Diğer akışların korunması

- **stop:** `stopCapture()` mevcut haliyle kalsın (containerCredentials temizleniyor).
- **addCredential:** Sunucuda credential oluşturup `containerCredentials` ve storage güncellemesi aynen kalır.
- **removeCredential:** Silme + `containerCredentials` ve storage güncellemesi aynen kalır.
- **onBeforeSendHeaders:** `mapping = containerCredentials[containerId]` ve **tarayıcı → sunucu** sync mantığı değişmez: tarayıcıdaki header’lar `lastHeaders` ile karşılaştırılır, fark varsa `syncCredentialHeaders` (PATCH) ile sunucu güncellenir. Resume/init sonrası mapping doğru dolacağı için bu akış aynen çalışır.
- **sendToServer / sendIngest:** `mapping?.credentialID` ile payload’a `credential_id` eklenmesi aynen kalır.

Popup tarafında değişiklik gerekmez; Start zaten `sessionID` (yeni veya seçilmiş) gönderiyor.

---

## 6. Uygulama sırası (özet)

1. **background.js:** `applySessionCredentials(sid)` yardımcısını ekle (loadSessionCredentials kullanıp containerCredentials + storage güncellesin).
2. **background.js:** "start" handler’da `message.sessionID` varken bu yardımcıyı çağır, sonra `startCapture` + async `sendResponse`.
3. **background.js:** `init()` içinde restore durumunda önce `applySessionCredentials(activeSessionID)` (veya load + apply), sonra `startCapture`.
4. **background.js:** (İsteğe bağlı) `attachSession` içinde credential doldurmayı `applySessionCredentials` ile değiştir.
5. Manuel test: yeni session, resume (seçili session + Start), tarayıcı yenileme/restart, credential ekleme/silme, header değişince PATCH’in tetiklenmesi.

Bu plan uygulandığında önceki session’dan devam edildiğinde credential bilgisi API’den alınacak ve hem senkron hem ingest doğru session’a göre çalışacaktır.
