/**
 * 맵 이미지의 작은 장애물 군집을 정리하는 Bun 실험 도구 (experimental-v1)
 * ======================================================================
 * 목적
 *   1st Floor 맵에서 작고 불규칙한 장애물 조각이 인접해 반복되는 패턴을 찾아,
 *   선택된 조각과 제한된 주변 테두리만 흰색 바닥으로 변경한 PNG를 생성한다.
 *   원본 이미지, occupancy 파일, FMS 상태나 데이터베이스는 수정하지 않는다.
 *
 * 실행
 *   bun run resources/tools/map_noise_cleanup.ts [입력.png] [출력디렉터리]
 *   인자 생략 시 resources/maps/1st_floor.png를 읽어 share/map-noise-experiment에 저장한다.
 *   기본 경로는 이 파일의 위치 기준, 사용자가 준 상대 경로는 실행 디렉터리 기준이다.
 *   비인터레이스 8비트 RGBA PNG만 지원하며 Bun 내장 모듈 외 의존성은 없다.
 *
 * 처리 흐름
 *   1. PNG의 IDAT 압축과 행별 필터를 복원해 RGBA 픽셀 배열을 얻는다.
 *   2. RGB 평균 밝기 100 미만의 픽셀을 8방향 연결 요소로 묶는다.
 *      요소마다 면적, 경계 사각형, 둘레, 채움 비율, 종횡비를 계산한다.
 *   3. 면적 100px 이하·최대 변 22px 이하인 조각 중 형태 조건과 주변 바닥
 *      비율(4px 사각 테두리에서 밝기 230 이상이 60% 이상)을 만족하는 것을 고른다.
 *   4. 큰 장애물(101px 이상)에서 4px 이내인 조각과 큰 회색 영역 주변은 보존한다.
 *      회색 영역은 밝기 120~220의 연결 요소 중 128px 이상을 기준으로 보호한다.
 *   5. 실제 픽셀 사이 체비쇼프 거리 20px 이내에 이웃이 3개 이상 있는 후보를 찾는다.
 *      자기 자신 포함 4개 이상의 국소 묶음이 최대 변 80px 이내일 때 선택한다.
 *   6. 선택한 검은 픽셀과 그 원래 마스크에서 2px 이내의 밝기 100~229 테두리를
 *      정리한다. 보호된 회색 영역과 보존할 검은 픽셀 주변은 변경하지 않는다.
 *   7. 정제본, 변경 위치 표시본, 분석 JSON을 저장한다. 기본 맵에는 확대 비교도 만든다.
 *
 * 출력과 재현 기준
 *   <입력명>.cleaned.png  : 선택 픽셀을 불투명 흰색으로 바꾼 전체 지도
 *   <입력명>.removals.png : 같은 변경 픽셀을 원본 위에 빨간색으로 표시한 검수 이미지
 *   metrics.json         : 임계값, 연결 요소의 특징, 선택 ID, 변경 픽셀 수
 *   1st_floor.detail.png : 기본 맵 중앙 하단의 원본/정제본을 좌우로 3배 확대 비교
 *   검토한 720×560 원본 기준: 연결 요소 189개, 선택 37개, 변경 901px(테두리 722px).
 *
 * 설계 근거와 한계
 *   연결 요소 분석·형상 특징·거리 기반 이웃 계산을 조합한 휴리스틱이다.
 *   실제 장애물과 스캔 노이즈를 판별하는 학습 모델이나 검증된 의미 분류기가 아니다.
 *   군집은 겹칠 수 있는 국소 이웃 묶음이며 DBSCAN이나 재귀적 군집 병합이 아니다.
 *   모든 거리·면적 임계값은 픽셀 기준이다. 다른 해상도·축척에는 별도 조정이 필요하다.
 *   회색을 미관측 영역의 후보로 해석하는 것은 이 원본의 표현에 따른 가정이다.
 *   일부 옅은 윤곽·고립된 조각은 남을 수 있다. 확대 비교 좌표는 표시용으로만 쓰이며,
 *   검출에는 ROI 제한 없이 맵 전체에 같은 규칙을 적용한다.
 *   주행 적용에는 결과 검토, occupancy/inflated 재생성, 버전·로봇 동기화가 별도로 필요하다.
 *
 * 구현 주의
 *   pixelGap은 정확한 최솟값을 반환하는 함수가 아니라 임계 거리 이내 여부의 검사다.
 *   테두리 제거는 불변 selectedDark를 기준으로 해야 스캔 순서에 따른 연쇄 확장을 막는다.
 *   PNG 디코더는 이 실험용 제한 구현이며 청크 CRC 등 모든 입력 무결성을 검증하지 않는다.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 0. CLI 경로 설정: import.meta.url을 사용해 현재 작업 디렉터리와 기본 맵 위치를 분리한다.
const defaultSource = fileURLToPath(new URL("../maps/1st_floor.png", import.meta.url));
const args = Bun.argv.slice(2);
if (args.includes("--help")) {
    console.log("Usage: bun run resources/tools/map_noise_cleanup.ts [input.png] [output-directory]\nDefaults: bundled 1st_floor.png -> share/map-noise-experiment\nSupported input: non-interlaced 8-bit RGBA PNG. Original is preserved.");
    process.exit(0);
}
if (args.length > 2 || args.some(arg => arg.startsWith("--")))
    throw new Error("Expected [input.png] [output-directory]; see --help");
const SOURCE = args[0] ? resolve(args[0]) : defaultSource;
const OUT = args[1] ? resolve(args[1]) : fileURLToPath(new URL("../../share/map-noise-experiment/", import.meta.url));
const stem = basename(SOURCE).replace(/\.png$/i, "");
// 생성할 PNG의 경로가 입력과 같은 경우를 거절한다. 기존 출력 파일은 재실행 시 갱신한다.
// 여기서는 정규화한 경로 문자열을 비교하며, 심볼릭 링크의 실제 대상까지 비교하지는 않는다.
for (const suffix of ["cleaned", "removals", "detail"]) {
    if (resolve(OUT, `${stem}.${suffix}.png`) === SOURCE)
        throw new Error("Output must not overwrite the input");
}
// 판정 설정: 밝기 0~255, 거리 px, 면적은 픽셀 수, 비율은 무차원이다.
// 주의: 회색 근접 검사 ±2, 테두리 밝기 100~229·탐색 ±2, 보존 장애물 근접 1은
// 아래 본문에 고정되어 있다. 관련 설정을 바꿀 때 이 값들도 함께 검토해야 한다.
const THRESHOLDS = {
    // 장애물 핵심 픽셀: RGB 평균이 이 값보다 작을 때만 검은 마스크에 포함한다.
    darkLumaExclusive: 100,
    // 보호할 회색 영역을 찾는 밝기 구간의 하한(포함).
    unknownMin: 120,
    // 회색 구간의 상한(포함). 작은 회색 테두리까지 모두 보호하지 않도록 면적도 검사한다.
    unknownMax: 220,
    // 주변 바닥 지지율 계산에서 흰색 바닥으로 인정할 최소 밝기.
    floorMin: 230,
    // 작은 장애물 후보의 최대 픽셀 수. 물리 면적(m²)이 아니다.
    smallAreaMax: 100,
    // 후보 경계 사각형의 가로·세로 중 큰 값의 상한(px). 긴 벽 조각을 걸러낸다.
    smallExtentMax: 22,
    // 이 픽셀 수 이상이면 근접 후보를 보호하는 큰 장애물로 취급한다.
    majorAreaMin: 101,
    // 큰 장애물의 실제 검은 픽셀에서 이 거리 이내인 후보는 보존한다.
    majorClearancePx: 4,
    // 두 후보의 실제 픽셀 사이 인접 판정 거리. 체비쇼프 거리(px)를 사용한다.
    componentLinkGapPx: 20,
    // 한 후보와 가까운 이웃을 합친 국소 묶음 경계의 최대 가로·세로 길이.
    clusterExtentMax: 80,
    // 중심 후보 자신을 포함한 최소 묶음 크기.
    clusterMinComponents: 4,
    // 중심 후보를 제외한 최소 이웃 수. 기본값은 자신 포함 4개 조건과 대응한다.
    clusterNeighborMin: 3,
    // 선택된 원래 검은 픽셀에서 허용할 테두리 거리. 현재 탐색 루프도 ±2px이다.
    fringeMaxDistancePx: 2,
    // 이 크기 이상의 회색 연결 요소만 보호한다. 작은 흐림 테두리와 구분하기 위한 기준.
    grayProtectedAreaMin: 128,
    // 보호 회색 연결 요소를 사각 이웃으로 확장할 반경. 확장 결과를 다시 확장하지 않는다.
    grayMarginPx: 1,
    // 후보 사각 경계 바깥에서 바닥 비율을 측정할 테두리 폭.
    floorSupportRadiusPx: 4,
    // 테두리의 유효 픽셀 중 floorMin 이상인 픽셀이 차지해야 하는 최소 비율.
    floorSupportRatio: 0.6,
    // 형태 조건 A: 매우 작은 조각은 원형도와 무관하게 통과시킨다.
    shapeAreaMax: 32,
    // 형태 조건 B: 면적 / 경계 사각형 면적이 낮으면 가늘거나 성긴 조각으로 본다.
    shapeFillMax: 0.75,
    // 형태 조건 C: 긴 변 / 짧은 변이 크면 길쭉한 조각으로 본다. A/B/C는 OR 조건이다.
    shapeAspectMin: 1.6,
};
/** pixels는 좌상단부터 행 우선으로 나열한 RGBA 바이트 배열(width * height * 4). */
type Png = {
    width: number;
    height: number;
    pixels: Uint8Array;
};
/**
 * 검은 연결 요소 하나의 특징. pixels는 RGBA 바이트 위치가 아니라 y * width + x 인덱스다.
 * 경계 min/max는 양 끝을 포함한다. perimeter는 상하좌우로 노출된 변의 합으로,
 * 유클리드 윤곽 길이와 다르며 현재 판정에는 쓰지 않고 검수용으로 기록한다.
 * fill은 사각 경계 내 채움 비율, aspect는 긴 변/짧은 변으로 항상 1 이상이다.
 */
type Component = {
    id: number;
    pixels: number[];
    area: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    perimeter: number;
    fill: number;
    aspect: number;
};
// i는 RGBA 바이트 오프셋이다. 지각 가중 휘도가 아닌 단순 RGB 평균이며 알파는 판정에 쓰지 않는다.
const luma = (p: Uint8Array, i: number) => (p[i] + p[i + 1] + p[i + 2]) / 3;
/** PNG Paeth 예측: 좌(a)·상(b)·좌상(c) 중 a+b-c 예측값에 가장 가까운 값을 선택한다. */
function paeth(a: number, b: number, c: number) { const q = a + b - c; const aa = Math.abs(q - a), bb = Math.abs(q - b), cc = Math.abs(q - c); return aa <= bb && aa <= cc ? a : bb <= cc ? b : c; }
/**
 * 제한형 PNG 읽기: 시그니처 → IHDR 형식 확인 → IDAT 결합/해제 → 행 필터 복원.
 * RGB·팔레트·그레이스케일·인터레이스는 지원하지 않는다.
 * 읽을 때 청크 CRC나 모든 길이/헤더 조합까지 검사하는 범용 디코더는 아니다.
 */
function decodePng(data: Uint8Array): Png {
    if (data.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
        throw new Error("Invalid PNG signature");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let width = 0, height = 0, depth = 0, type = 0, off = 8;
    const idats: Uint8Array[] = [];
    // 청크는 길이 4바이트 + 종류 4바이트 + 본문 n바이트 + CRC 4바이트 구조다.
    // getUint32는 기본 big-endian으로 PNG 길이 필드와 일치한다.
    while (off + 12 <= data.length) {
        const n = view.getUint32(off);
        const t = String.fromCharCode(...data.subarray(off + 4, off + 8));
        const c = data.subarray(off + 8, off + 8 + n);
        off += n + 12;
        if (t === "IHDR") {
            const h = new DataView(c.buffer, c.byteOffset, c.byteLength);
            width = h.getUint32(0);
            height = h.getUint32(4);
            depth = c[8];
            type = c[9];
            if (c[12] !== 0)
                throw new Error("Interlaced PNG is not supported");
        }
        else if (t === "IDAT")
            idats.push(c);
        else if (t === "IEND")
            break;
    }
    if (depth !== 8 || type !== 6)
        throw new Error("expected 8-bit RGBA PNG");
    // 여러 IDAT는 하나의 zlib 스트림이므로 먼저 연결한 뒤 압축을 해제한다.
    const raw = inflateSync(Buffer.concat(idats.map((x) => Buffer.from(x))));
    const stride = width * 4, pixels = new Uint8Array(width * height * 4), prev = new Uint8Array(stride);
    let src = 0;
    // 각 행의 첫 바이트는 필터 종류다. RGBA 8bit이므로 같은 채널의 왼쪽 값은 4바이트 전이다.
    for (let y = 0; y < height; y++) {
        const f = raw[src++];
        const row = Uint8Array.from(raw.subarray(src, src + stride));
        src += stride;
        for (let x = 0; x < stride; x++) {
            const left = x >= 4 ? row[x - 4] : 0, up = prev[x], ul = x >= 4 ? prev[x - 4] : 0;
            // 0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth. 이미 복원한 왼쪽/윗행을 사용한다.
            // &255는 PNG 필터 복원의 8비트 모듈러 덧셈이다.
            if (f === 1)
                row[x] = (row[x] + left) & 255;
            else if (f === 2)
                row[x] = (row[x] + up) & 255;
            else if (f === 3)
                row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
            else if (f === 4)
                row[x] = (row[x] + paeth(left, up, ul)) & 255;
            else if (f !== 0)
                throw new Error(`unsupported PNG filter ${f}`);
        }
        pixels.set(row, y * stride);
        prev.set(row);
    }
    return { width, height, pixels };
}
// PNG 쓰기에 사용할 CRC-32 룩업 테이블. 청크 종류와 본문을 합쳐 CRC를 계산한다.
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
}
/** 부호 없는 32비트 CRC를 반환한다. 읽기 검증이 아니라 출력 청크 작성에 사용한다. */
function crc32(b: Uint8Array) { let c = 0xffffffff; for (const x of b)
    c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** 정수를 PNG 규격의 4바이트 big-endian으로 직렬화한다. */
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
/** length | type | data | CRC(type+data) 순서로 PNG 청크를 만든다. */
function chunk(name: string, body: Uint8Array) { const t = new TextEncoder().encode(name), b = new Uint8Array(4 + body.length); b.set(t); b.set(body, 4); const out = new Uint8Array(body.length + 12); out.set(u32(body.length)); out.set(b, 4); out.set(u32(crc32(b)), body.length + 8); return out; }
/**
 * RGBA 결과를 비인터레이스 PNG로 기록한다. 모든 행을 필터 0(None)으로 구성한 뒤
 * zlib 압축하고 IHDR/IDAT/IEND를 작성한다. 원본 메타데이터 청크는 복사하지 않는다.
 */
function encodePng(width: number, height: number, pixels: Uint8Array) { const raw = new Uint8Array(height * (width * 4 + 1)); for (let y = 0; y < height; y++) {
    const o = y * (width * 4 + 1);
    raw[o] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), o + 1);
} const h = new Uint8Array(13), v = new DataView(h.buffer); v.setUint32(0, width); v.setUint32(4, height); h[8] = 8; h[9] = 6; const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), parts = [sig, chunk("IHDR", h), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())], out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) {
    out.set(x, o);
    o += x.length;
} return out; }
// 1. 원본 읽기와 검은 핵심 픽셀 마스크 생성. 원본 pixels 배열은 이후에도 변경하지 않는다.
const png = decodePng(new Uint8Array(await Bun.file(SOURCE).bytes()));
const { width, height, pixels } = png;
const count = width * height;
const dark = new Uint8Array(count);
for (let i = 0; i < count; i++)
    dark[i] = luma(pixels, i * 4) < THRESHOLDS.darkLumaExclusive ? 1 : 0;
// 2. 8방향 연결 요소 BFS. labels=-1은 미지정이며 요소 ID 0과 구별해야 한다.
const components: Component[] = [], labels = new Int32Array(count);
labels.fill(-1);
// 연결성은 대각선을 포함한 8방향, 둘레 집계는 실제 사각 픽셀 변에 대응하는 4방향이다.
const dirs = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];
const orth = [-1, 0, 1, 0, 0, -1, 0, 1];
for (let start = 0; start < count; start++) {
    if (!dark[start] || labels[start] >= 0)
        continue;
    // 큐에서 shift하지 않고 q 인덱스를 증가시켜 배열 앞쪽 제거 비용을 피한다.
    const id = components.length, queue = [start], cp: number[] = [];
    labels[start] = id;
    let minX = width, minY = height, maxX = 0, maxY = 0, perimeter = 0;
    for (let q = 0; q < queue.length; q++) {
        const at = queue[q], x = at % width, y = Math.floor(at / width);
        cp.push(at);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        for (let d = 0; d < 8; d += 2) {
            const nx = x + orth[d], ny = y + orth[d + 1];
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || !dark[ny * width + nx])
                perimeter++;
        }
        for (let d = 0; d < 16; d += 2) {
            const nx = x + dirs[d], ny = y + dirs[d + 1];
            if (nx < 0 || ny < 0 || nx >= width || ny >= height)
                continue;
            const ni = ny * width + nx;
            if (dark[ni] && labels[ni] < 0) {
                // 큐에 넣을 때 방문 표시해 같은 픽셀이 여러 번 추가되는 것을 막는다.
                labels[ni] = id;
                queue.push(ni);
            }
        }
    }
    // 경계 양 끝 픽셀을 포함하므로 길이에 +1이 필요하다.
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    components.push({ id, pixels: cp, area: cp.length, minX, minY, maxX, maxY, perimeter, fill: cp.length / (bw * bh), aspect: Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) });
}
// 3. 큰 구조물과 작은 후보 분리. 작아도 최대 변 길이 조건을 넘으면 후보로 사용하지 않는다.
const major = components.filter((c) => c.area >= THRESHOLDS.majorAreaMin);
const small = components.filter((c) => c.area <= THRESHOLDS.smallAreaMax && Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1) <= THRESHOLDS.smallExtentMax);
// 4. 회색 영역 보호. 검은 조각의 작은 회색 테두리와 큰 미관측 영역을 면적으로 구분한다.
const gray = new Uint8Array(count);
for (let i = 0; i < count; i++) {
    const v = luma(pixels, i * 4);
    gray[i] = v >= THRESHOLDS.unknownMin && v <= THRESHOLDS.unknownMax ? 1 : 0;
}
// 회색 자체의 연결 요소를 별도로 구한다. graySeen은 방문, protectedGray는 최종 보호 마스크다.
const protectedGray = new Uint8Array(count), graySeen = new Uint8Array(count);
for (let s = 0; s < count; s++) {
    if (!gray[s] || graySeen[s])
        continue;
    const q = [s], gp: number[] = [];
    graySeen[s] = 1;
    for (let n = 0; n < q.length; n++) {
        const at = q[n], x = at % width, y = Math.floor(at / width);
        gp.push(at);
        for (let d = 0; d < 16; d += 2) {
            const nx = x + dirs[d], ny = y + dirs[d + 1];
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                const ni = ny * width + nx;
                if (gray[ni] && !graySeen[ni]) {
                    graySeen[ni] = 1;
                    q.push(ni);
                }
            }
        }
    }
    // 큰 회색 요소의 원래 픽셀들만 기준으로 여유 폭을 붙인다.
    // 생성된 protectedGray를 BFS에 쓰지 않으므로 보호 영역이 연쇄 확장되지 않는다.
    if (gp.length >= THRESHOLDS.grayProtectedAreaMin)
        for (const at of gp) {
            const x = at % width, y = Math.floor(at / width);
            for (let yy = -THRESHOLDS.grayMarginPx; yy <= THRESHOLDS.grayMarginPx; yy++)
                for (let xx = -THRESHOLDS.grayMarginPx; xx <= THRESHOLDS.grayMarginPx; xx++) {
                    const nx = x + xx, ny = y + yy;
                    if (nx >= 0 && ny >= 0 && nx < width && ny < height)
                        protectedGray[ny * width + nx] = 1;
                }
        }
}
/**
 * 두 경계 사각형 사이의 빈 픽셀 간격을 이용한 빠른 하한 검사.
 * -1은 사각 경계 사이의 빈 칸 수를 세기 위한 것으로 실제 픽셀 중심 거리보다 작을 수 있다.
 * 큰 벽의 사각 경계가 방 전체를 감쌀 수 있으므로 이 값만으로 근접을 확정하면 안 된다.
 */
function boxGap(a: Component, b: Component) { const dx = Math.max(a.minX - b.maxX - 1, b.minX - a.maxX - 1, 0), dy = Math.max(a.minY - b.maxY - 1, b.minY - a.maxY - 1, 0); return Math.max(dx, dy); }
/**
 * 실제 픽셀 쌍에 대해 max(|dx|, |dy|) <= limit인지 검사한다(체비쇼프 거리).
 * 반환 0: 조건을 만족하는 쌍을 찾음. 반환 >limit: 해당 거리 내 쌍이 없음.
 * 이름과 달리 정확한 최소 거리를 산출하지 않으며 호출부는 <=limit 검사만 해야 한다.
 * 사각 경계 하한으로 먼 쌍을 먼저 제외한다. 남은 경우 비용은 두 요소 픽셀 수의 곱에 비례한다.
 */
function pixelGap(a: Component, b: Component, limit: number) {
    if (boxGap(a, b) > limit)
        return boxGap(a, b);
    for (const ai of a.pixels) {
        const ax = ai % width, ay = Math.floor(ai / width);
        for (const bi of b.pixels) {
            const bx = bi % width, by = Math.floor(bi / width);
            if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= limit)
                return 0;
        }
    }
    return limit + 1;
}
/**
 * 5. 후보 사각 경계 바깥의 사각 고리에서 바닥 비율을 검사한다.
 * 후보 내부는 제외하고 이미지 밖은 잘라낸다. 고리의 각 좌표를 한 번만 세어
 * 후보 픽셀별 중복 집계로 지지율이 부풀려지는 것을 피한다.
 * total이 0이면 분모를 1로 두어 통과하지 않게 한다.
 */
const hasFloorSupport = (a: Component) => { let support = 0, total = 0; for (let y = Math.max(0, a.minY - THRESHOLDS.floorSupportRadiusPx); y <= Math.min(height - 1, a.maxY + THRESHOLDS.floorSupportRadiusPx); y++)
    for (let x = Math.max(0, a.minX - THRESHOLDS.floorSupportRadiusPx); x <= Math.min(width - 1, a.maxX + THRESHOLDS.floorSupportRadiusPx); x++) {
        if (x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY)
            continue;
        total++;
        if (luma(pixels, (y * width + x) * 4) >= THRESHOLDS.floorMin)
            support++;
    } return support / Math.max(1, total) >= THRESHOLDS.floorSupportRatio; };
// 형태 조건(A/B/C 중 하나) AND 바닥 비율 AND 큰 장애물과의 거리 AND 회색 보호 조건.
// 이 단계를 각 후보에 먼저 적용하므로 이웃으로 묶이면서 보호 조건을 우회하지 않는다.
const eligible = small.filter((a) => {
    const shape = a.area <= THRESHOLDS.shapeAreaMax || a.fill <= THRESHOLDS.shapeFillMax || a.aspect >= THRESHOLDS.shapeAspectMin;
    return shape && hasFloorSupport(a) && !major.some((m) => pixelGap(a, m, THRESHOLDS.majorClearancePx) <= THRESHOLDS.majorClearancePx) && !a.pixels.some((at) => { const x = at % width, y = Math.floor(at / width); for (let yy = -2; yy <= 2; yy++)
        for (let xx = -2; xx <= 2; xx++) {
            const nx = x + xx, ny = y + yy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height && protectedGray[ny * width + nx])
                return true;
        } return false; });
});
// 6. 국소 밀집 패턴 검출. 중심 후보와 직접 가까운 이웃만 묶고 이웃의 이웃으로 확장하지 않는다.
const selected = new Set<number>(), clusterOf = new Map<number, number>();
let clusterId = 0;
for (const a of eligible) {
    const near = eligible.filter((b) => b.id !== a.id && pixelGap(a, b, THRESHOLDS.componentLinkGapPx) <= THRESHOLDS.componentLinkGapPx);
    if (near.length < THRESHOLDS.clusterNeighborMin)
        continue;
    // 이웃은 자기 자신을 제외했다. 군집 크기·외곽 크기는 자기 자신을 다시 포함해 검사한다.
    const group = [a, ...near];
    const minX = Math.min(...group.map((c) => c.minX)), minY = Math.min(...group.map((c) => c.minY)), maxX = Math.max(...group.map((c) => c.maxX)), maxY = Math.max(...group.map((c) => c.maxY));
    if (group.length < THRESHOLDS.clusterMinComponents || Math.max(maxX - minX + 1, maxY - minY + 1) > THRESHOLDS.clusterExtentMax)
        continue;
    // 묶음들은 서로 겹칠 수 있다. Set은 중복 삭제를 막으며 clusterOf는 마지막 묶음 ID를 남긴다.
    // 개별 이웃의 이웃 수가 부족해도 조건을 만족한 중심 후보의 묶음에 속하면 선택된다.
    for (const c of group) {
        selected.add(c.id);
        clusterOf.set(c.id, clusterId);
    }
    clusterId++;
}
// 7. 선택된 핵심 픽셀을 제거 마스크에 기록하고, 테두리 검사 기준으로 쓸 불변 복사본을 만든다.
const removed = new Uint8Array(count);
for (const id of selected)
    for (const at of components[id].pixels)
        removed[at] = 1;
const selectedDark = Uint8Array.from(removed);
// 테두리 정리: 밝기 100~229만 고려한다. 검은 핵심(<100)은 위에서 이미 선택했고,
// 밝은 픽셀은 이 단계에서 바꾸지 않는다. removed를 인접 기준으로 사용하면 방금 추가한
// 테두리에서 다시 확장되므로 반드시 selectedDark를 기준으로 한다.
// 아래 루프의 탐색 반경 ±2와 보존 장애물 거리 1은 고정값이다.
for (let at = 0; at < count; at++) {
    if (removed[at])
        continue;
    const v = luma(pixels, at * 4);
    if (v < 100 || v > 229)
        continue;
    const x = at % width, y = Math.floor(at / width);
    let adjacent = false, unsafe = false;
    for (let yy = -2; yy <= 2; yy++)
        for (let xx = -2; xx <= 2; xx++) {
            const nx = x + xx, ny = y + yy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height)
                continue;
            const ni = ny * width + nx, lv = luma(pixels, ni * 4);
            if (selectedDark[ni] && Math.max(Math.abs(xx), Math.abs(yy)) <= THRESHOLDS.fringeMaxDistancePx)
                adjacent = true;
            // 검사 중인 테두리 주변 2px 안에 보호 마스크가 하나라도 있으면 보존한다.
            if (protectedGray[ni])
                unsafe = true;
            // 선택하지 않은 검은 픽셀의 바로 옆은 보존해 정상 장애물의 경계를 깎지 않는다.
            if (ni !== at && !selectedDark[ni] && lv < 100 && Math.max(Math.abs(xx), Math.abs(yy)) <= 1)
                unsafe = true;
        }
    if (adjacent && !unsafe)
        removed[at] = 1;
}
// 8. 원본을 각각 복사한 두 결과에 동일한 마스크를 적용한다.
// 정제본은 불투명 흰색, 검수본은 불투명 빨간색이다. 마스크 밖의 RGBA는 그대로 보존된다.
const cleaned = Uint8Array.from(pixels), auditPixels = Uint8Array.from(pixels);
let removedPixels = 0, fringePixels = 0;
for (let i = 0; i < count; i++)
    if (removed[i]) {
        const p = i * 4;
        cleaned[p] = cleaned[p + 1] = cleaned[p + 2] = 255;
        cleaned[p + 3] = 255;
        auditPixels[p] = 255;
        auditPixels[p + 1] = 0;
        auditPixels[p + 2] = 0;
        auditPixels[p + 3] = 255;
        removedPixels++;
        // 원래 검은 연결 요소에 속하지 않았던 변경 픽셀만 테두리 변경으로 집계한다.
        if (labels[i] < 0)
            fringePixels++;
    }
// 9. 기본 맵 전용 표시용 확대 비교. 이 좌표는 위 검출이나 삭제 조건에는 관여하지 않는다.
// 기본 원본 경로가 일치하고 범위를 포함할 때만 생성한다.
const includeDetail = SOURCE === defaultSource && width >= 331 && height >= 501;
const cx = 225, cy = 410, cw = 106, ch = 91, scale = 3, detail = new Uint8Array(cw * 2 * scale * ch * scale * 4);
if (includeDetail)
    for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw * 2; x++) {
            // 좌우 절반에서 동일 원본 좌표를 읽고 3×3으로 복제한다(최근접 확대).
            // x<cw이면 원본, 나머지는 정제본. y는 이미 원본 좌표 단위이므로 scale로 나누지 않는다.
            const src = (cy + y) * width + (cx + (x % cw));
            const sp = (src * 4), dp = (y * scale * (cw * 2 * scale) + x * scale) * 4;
            for (let yy = 0; yy < scale; yy++)
                for (let xx = 0; xx < scale; xx++)
                    detail[dp + (yy * (cw * 2 * scale) + xx) * 4] = x < cw ? pixels[sp] : cleaned[sp], detail[dp + (yy * (cw * 2 * scale) + xx) * 4 + 1] = x < cw ? pixels[sp + 1] : cleaned[sp + 1], detail[dp + (yy * (cw * 2 * scale) + xx) * 4 + 2] = x < cw ? pixels[sp + 2] : cleaned[sp + 2], detail[dp + (yy * (cw * 2 * scale) + xx) * 4 + 3] = 255;
        }
// 10. 결과 저장. 같은 출력 이름은 갱신된다. 원본 입력 파일과 FMS 데이터는 쓰지 않는다.
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${stem}.cleaned.png`), encodePng(width, height, cleaned));
writeFileSync(join(OUT, `${stem}.removals.png`), encodePng(width, height, auditPixels));
if (includeDetail)
    writeFileSync(join(OUT, `${stem}.detail.png`), encodePng(cw * 2 * scale, ch * scale, detail));
// 실행 조건과 요소별 특징을 함께 기록해 제거 이유를 추적한다.
// selected=false 요소도 포함하며, cluster는 독립된 전역 군집 ID가 아닌 마지막 국소 묶음 ID다.
writeFileSync(join(OUT, "metrics.json"), JSON.stringify({ algorithmVersion: "experimental-v1", source: SOURCE, width, height, thresholds: THRESHOLDS, componentCount: components.length, majorComponentCount: major.length, smallCandidateCount: small.length, eligibleCandidateCount: eligible.length, selectedComponentIds: [...selected].sort((a, b) => a - b), selectedComponentCount: selected.size, removedPixels, fringePixels, components: components.map((c) => ({ id: c.id, area: c.area, bbox: [c.minX, c.minY, c.maxX, c.maxY], perimeter: c.perimeter, fill: Number(c.fill.toFixed(4)), aspect: Number(c.aspect.toFixed(4)), selected: selected.has(c.id), cluster: clusterOf.get(c.id) ?? null })) }, null, 2) + "\n");
// CLI에는 요약만 출력한다. 세부 요소 목록은 metrics.json에서 확인할 수 있다.
console.log(JSON.stringify({ width, height, componentCount: components.length, selectedComponentCount: selected.size, removedPixels, fringePixels, outputs: OUT }, null, 2));
