/**
 * streamTracks.ts — парсинг встроенных аудиопотоков из контейнера MKV
 * (metadata TorrServer /stream probe info).
 *
 * MKV — это EBML: в начале файла лежит Segment → Tracks → TrackEntry, где для
 * каждой дорожки указаны TrackType (2 = audio), Language (ISO 639-2),
 * Name (название студии озвучки, например «RHS» / «Дубляж») и CodecID
 * (A_DTS, A_AC3, A_TRUEHD, A_AAC…). Достаточно прочитать первые ~2 МБ файла
 * (Range-запрос) — Tracks находится рядом с началом сегмента.
 *
 * Выбранный index уходит в поток TorrServer gst как `audio=N` — транскодирование
 * именно этой дорожки в AAC (Lampa-style Audio Track Switcher).
 */

/** Аудиодорожка из контейнера MKV. */
export interface StreamAudioTrack {
  /** Позиция среди аудио-дорожек (0-based) — значение для `audio=N` в gst-URL. */
  index: number;
  /** Номер дорожки в контейнере (TrackNumber). */
  trackNumber: number;
  /** ISO 639-2 код языка (rus/eng/ger…). */
  language: string;
  /** Название студии озвучки из Name-элемента (может быть пустым). */
  name: string;
  /** Кодек: DTS / DTS-HD / AC3 / E-AC3 / TrueHD / AAC / MP3 / Opus / FLAC / PCM… */
  codec: string;
}

/** Короткое имя языка для UI. */
const LANG_NAMES: Record<string, string> = {
  rus: 'Русский', ukr: 'Украинский', eng: 'English', ger: 'Немецкий', fre: 'Французский',
  spa: 'Испанский', ita: 'Итальянский', pol: 'Польский', jpn: 'Японский', kor: 'Корейский',
  chi: 'Китайский', tur: 'Турецкий', hin: 'Хинди', ara: 'Арабский', por: 'Португальский',
  dut: 'Голландский', swe: 'Шведский', nor: 'Норвежский', dan: 'Датский', fin: 'Финский',
  cze: 'Чешский', hun: 'Венгерский', rum: 'Румынский', bul: 'Болгарский', gre: 'Греческий',
  heb: 'Иврит', und: 'Без языка',
};

export function languageName(code: string): string {
  const c = (code || '').toLowerCase();
  return LANG_NAMES[c] || c || '';
}

function codecLabel(codecId: string): string {
  const c = codecId || '';
  if (/A_TRUEHD|ATMOS/.test(c)) return 'TrueHD';
  if (/DTS/.test(c)) return 'DTS';
  if (/A_EAC3/.test(c)) return 'E-AC3';
  if (/A_AC3/.test(c)) return 'AC3';
  if (/A_AAC/.test(c)) return 'AAC';
  if (/A_OPUS/.test(c)) return 'Opus';
  if (/A_FLAC/.test(c)) return 'FLAC';
  if (/A_VORBIS/.test(c)) return 'Vorbis';
  if (/A_MPEG\/L3/.test(c)) return 'MP3';
  if (/A_PCM/.test(c)) return 'PCM';
  if (/A_MLP/.test(c)) return 'MLP';
  return c.replace(/^A_/, '') || 'Audio';
}

// ── EBML-примитивы ──

interface EbmlSize {
  value: number;
  length: number;
  /** Все биты — единицы: размер неизвестен (часто у Segment в стриминг-MKV). */
  unknown: boolean;
}

/** Прочитать EBML size (variable-length int). null — конец данных/невалид. */
function ebmlSize(data: Uint8Array, pos: number): EbmlSize | null {
  if (pos >= data.length) return null;
  const first = data[pos];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
    if (length > 8) return null;
  }
  let value = first & (mask - 1);
  let allOnes = value === mask - 1; // не-маркерные биты первого байта
  for (let i = 1; i < length; i++) {
    if (pos + i >= data.length) return null;
    const b = data[pos + i];
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  if (allOnes && length > 1) {
    return { value: Number.MAX_SAFE_INTEGER, length, unknown: true };
  }
  return { value, length, unknown: false };
}

/** Прочитать EBML element ID (1-4 байта, маркерные биты — часть ID). */
function ebmlId(data: Uint8Array, pos: number): { id: number; length: number } | null {
  if (pos >= data.length) return null;
  const first = data[pos];
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
    if (length > 4) return null;
  }
  let id = 0;
  for (let i = 0; i < length; i++) {
    if (pos + i >= data.length) return null;
    id = id * 256 + data[pos + i];
  }
  return { id, length };
}

/** Читать ASCII/UTF-8 строку элемента (utf8 element). */
function ebmlString(data: Uint8Array, start: number, size: number): string {
  try {
    return new TextDecoder('utf-8')
      .decode(data.subarray(start, Math.min(data.length, start + size)))
      .replace(/\0/g, '')
      .trim();
  } catch {
    return '';
  }
}

/** ID элементов EBML (Matroska). */
const ID = {
  SEGMENT: 0x18538067,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  TRACK_NUMBER: 0xd7,
  LANGUAGE: 0x22b59c,
  NAME: 0x536e,
  CODEC_ID: 0x86,
};

/**
 * Разобрать аудиодорожки из буфера MKV (первые ~2 МБ файла).
 * Возвращает [] если Tracks-элемент не найден в пределах буфера.
 */
export function parseMkvAudioTracks(buffer: Uint8Array): StreamAudioTrack[] {
  const audio: StreamAudioTrack[] = [];
  const endOf = (start: number, size: EbmlSize | null) =>
    size ? Math.min(buffer.length, start + (size.unknown ? buffer.length : size.value)) : start;

  let pos = 0;

  // 1) Пропускаем EBML-заголовок (0x1A45DFA3) до Segment (0x18538067)
  while (pos + 4 < buffer.length) {
    const id = ebmlId(buffer, pos);
    if (!id) break;
    const size = ebmlSize(buffer, pos + id.length);
    if (!size) break;
    const headerLen = id.length + size.length;
    if (id.id === ID.SEGMENT) { pos += headerLen; break; }
    pos = endOf(pos + headerLen, size);
  }

  // 2) Идём по элементам Segment, ищем Tracks
  while (pos + 4 < buffer.length) {
    const id = ebmlId(buffer, pos);
    if (!id) break;
    const size = ebmlSize(buffer, pos + id.length);
    if (!size) break;
    const headerLen = id.length + size.length;
    if (id.id === ID.TRACKS) {
      // 3) Внутри Tracks — TrackEntry'и
      const tracksEnd = endOf(pos + headerLen, size);
      let tp = pos + headerLen;
      while (tp + 4 < tracksEnd) {
        const tId = ebmlId(buffer, tp);
        if (!tId) break;
        const tSize = ebmlSize(buffer, tp + tId.length);
        if (!tSize) break;
        const tHeader = tId.length + tSize.length;
        if (tId.id === ID.TRACK_ENTRY) {
          // 4) Поля дорожки
          let trackType = -1;
          let trackNumber = 0;
          let language = '';
          let name = '';
          let codecId = '';
          const entryEnd = endOf(tp + tHeader, tSize);
          let fp = tp + tHeader;
          while (fp + 4 < entryEnd) {
            const fId = ebmlId(buffer, fp);
            if (!fId) break;
            const fSize = ebmlSize(buffer, fp + fId.length);
            if (!fSize) break;
            const fHeader = fId.length + fSize.length;
            const fStart = fp + fHeader;
            const fEnd = Math.min(entryEnd, fStart + fSize.value);
            if (fId.id === ID.TRACK_TYPE && fEnd > fStart) {
              trackType = buffer[fStart];
            } else if (fId.id === ID.TRACK_NUMBER) {
              let v = 0;
              for (let i = fStart; i < fEnd && i < buffer.length; i++) v = v * 256 + buffer[i];
              trackNumber = v;
            } else if (fId.id === ID.LANGUAGE) {
              language = ebmlString(buffer, fStart, fSize.value);
            } else if (fId.id === ID.NAME) {
              name = ebmlString(buffer, fStart, fSize.value);
            } else if (fId.id === ID.CODEC_ID) {
              codecId = ebmlString(buffer, fStart, fSize.value);
            }
            fp = fEnd;
          }
          if (trackType === 2) {
            audio.push({
              index: audio.length,
              trackNumber,
              language,
              name,
              codec: codecLabel(codecId),
            });
          }
          tp = entryEnd;
        } else {
          tp = endOf(tp + tHeader, tSize);
        }
      }
      break; // Tracks найден и разобран
    }
    pos = endOf(pos + headerLen, size);
  }

  return audio;
}

/** Человекочитаемая подпись дорожки для UI: «Русский (RHS)», «Русский (Дубляж)», «English». */
export function audioTrackLabel(track: StreamAudioTrack): string {
  const lang = languageName(track.language);
  if (track.name) {
    // Студия озвучки в скобках: «Русский (RHS)». Если name == язык — без скобок.
    return lang && lang !== track.name ? `${lang} (${track.name})` : track.name;
  }
  return lang || `Дорожка ${track.index + 1}`;
}

/**
 * Получить список аудиодорожек MKV из потока TorrServer: Range-запрос
 * первых ~2 МБ файла + EBML-парсинг. При любой ошибке — [] (не критично:
 * UI просто не покажет расширенный селектор).
 */
export async function probeAudioTracks(streamUrl: string, timeoutMs = 8000): Promise<StreamAudioTrack[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-2097152' }, // 2 МБ — хватает на EBML-заголовок + Tracks
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok && res.status !== 206) return [];
    const buf = new Uint8Array(await res.arrayBuffer());
    return parseMkvAudioTracks(buf);
  } catch {
    return [];
  }
}
