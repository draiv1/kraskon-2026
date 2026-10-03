// Расчёт по проекту: читает PDF, Word, Excel и изображения в браузере,
// отправляет их в estimate.php и подставляет количества в калькулятор.
(() => {
    const MAX_IMAGES = 30;
    const MAX_SIDE = 1800;
    const JPEG_QUALITY = 0.82;
    const IMAGE_EXT = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|svg|ico|tiff?|heic|heif)$/i;

    const $ = id => document.getElementById(id);
    const dialog = $('projectModal');
    const form = $('projectForm');
    const statusEl = $('projectStatus');
    const resultEl = $('projectResult');
    const reportEl = $('projectReport');
    const submitBtn = $('projectSubmit');
    if (!dialog || !form) return;

    const scripts = {};
    function loadScript(src) {
        if (!scripts[src]) {
            scripts[src] = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = resolve;
                s.onerror = () => { delete scripts[src]; reject(new Error('Не удалось загрузить компонент ' + src)); };
                document.head.appendChild(s);
            });
        }
        return scripts[src];
    }

    function setStatus(text, isError = false) {
        statusEl.textContent = text;
        statusEl.classList.toggle('is-error', isError);
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // --- чтение файлов ------------------------------------------------------

    function parsePages(spec, total) {
        const pages = new Set();
        for (const chunk of spec.split(/[,;\s]+/).filter(Boolean)) {
            const m = chunk.match(/^(\d+)(?:-(\d+))?$/);
            if (!m) throw new Error('Не понял номера страниц «' + spec + '». Пример: 16-17 или 3, 5, 8-10.');
            const from = Number(m[1]);
            const to = Number(m[2] || m[1]);
            for (let p = Math.min(from, to); p <= Math.max(from, to); p++) {
                if (p >= 1 && p <= total) pages.add(p);
            }
        }
        return [...pages].sort((a, b) => a - b);
    }

    function canvasToJpeg(canvas) {
        return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
    }

    async function pdfToParts(file, pagesSpec) {
        await loadScript('vendor/pdf.min.js');
        const pdfjs = window.pdfjsLib;
        pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
        let pdf;
        try {
            pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        } catch (e) {
            throw new Error('Не удалось открыть PDF «' + file.name + '»' + (e && e.name === 'PasswordException' ? ': файл защищён паролем.' : '.'));
        }
        const pages = pagesSpec.trim()
            ? parsePages(pagesSpec, pdf.numPages)
            : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
        if (!pages.length) throw new Error('В PDF «' + file.name + '» нет страниц с указанными номерами (всего страниц: ' + pdf.numPages + ').');
        const parts = [];
        for (const [i, n] of pages.entries()) {
            setStatus('Читаю «' + file.name + '»: страница ' + (i + 1) + ' из ' + pages.length + '…');
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(MAX_SIDE / Math.max(base.width, base.height), 3) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            parts.push({ type: 'image', name: file.name + ', стр. ' + n, data: canvasToJpeg(canvas) });
            canvas.width = canvas.height = 0;
        }
        return parts;
    }

    async function imageToParts(file) {
        let source;
        try {
            source = await createImageBitmap(file);
        } catch (e) {
            source = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Браузер не смог открыть изображение «' + file.name
                    + '». Форматы HEIC и TIFF он не читает: сохраните файл как JPG или PNG либо сделайте снимок экрана.'));
                img.src = URL.createObjectURL(file);
            });
        }
        const width = source.width || source.naturalWidth || 1200;
        const height = source.height || source.naturalHeight || 1200;
        const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        if (source.close) source.close();
        return [{ type: 'image', name: file.name, data: canvasToJpeg(canvas) }];
    }

    async function docxToParts(file) {
        await loadScript('vendor/jszip.min.js');
        let xml;
        try {
            const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
            xml = await zip.file('word/document.xml').async('string');
        } catch (e) {
            throw new Error('Не удалось прочитать Word-файл «' + file.name + '». Сохраните его как .docx или PDF.');
        }
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const lines = [];
        const cellText = node => [...node.getElementsByTagName('w:t')].map(t => t.textContent).join('');
        const walk = node => {
            for (const child of node.children) {
                if (child.tagName === 'w:tbl') {
                    for (const row of child.getElementsByTagName('w:tr')) {
                        const cells = [...row.children].filter(c => c.tagName === 'w:tc').map(c => cellText(c).trim());
                        lines.push(cells.join(' | '));
                    }
                } else if (child.tagName === 'w:p') {
                    const text = cellText(child).trim();
                    if (text) lines.push(text);
                } else {
                    walk(child);
                }
            }
        };
        walk(doc.documentElement);
        return [{ type: 'text', name: file.name, text: lines.join('\n') }];
    }

    async function sheetToParts(file) {
        await loadScript('vendor/xlsx.full.min.js');
        let book;
        try {
            book = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
        } catch (e) {
            throw new Error('Не удалось прочитать таблицу «' + file.name + '».');
        }
        const sheets = book.SheetNames.map(name => {
            const csv = window.XLSX.utils.sheet_to_csv(book.Sheets[name], { FS: ' | ', blankrows: false });
            const rows = csv.split('\n').map(r => r.replace(/( \| )+$/, '')).filter(r => r.replace(/[\s|]/g, ''));
            return rows.length ? 'Лист «' + name + '»:\n' + rows.join('\n') : '';
        }).filter(Boolean);
        return [{ type: 'text', name: file.name, text: sheets.join('\n\n') }];
    }

    async function textToParts(file) {
        const buffer = await file.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buffer);
        if (text.includes('�')) text = new TextDecoder('windows-1251').decode(buffer);
        return [{ type: 'text', name: file.name, text }];
    }

    function fileToParts(file, pagesSpec) {
        const name = file.name.toLowerCase();
        if (file.type === 'application/pdf' || name.endsWith('.pdf')) return pdfToParts(file, pagesSpec);
        if (/\.(docx|docm)$/.test(name)) return docxToParts(file);
        if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) return sheetToParts(file);
        if (/\.(csv|txt)$/.test(name)) return textToParts(file);
        if (file.type.startsWith('image/') || IMAGE_EXT.test(name)) return imageToParts(file);
        if (/\.(doc|rtf|odt)$/.test(name)) {
            throw new Error('Файл «' + file.name + '» в старом формате. Сохраните его как .docx или PDF и загрузите снова.');
        }
        throw new Error('Файл «' + file.name + '» не поддерживается. Подходят PDF, Word (.docx), Excel и изображения.');
    }

    // --- результат ----------------------------------------------------------

    function priceRows() {
        const rows = new Map();
        document.querySelectorAll('#price-pane tr[data-price]').forEach(tr => {
            rows.set(Number(tr.cells[0].textContent), tr);
        });
        return rows;
    }

    const formatRub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';
    const formatQty = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

    function applyResult(result) {
        const rows = priceRows();
        document.querySelectorAll('#price-pane .qty-input').forEach(input => { input.value = '0'; });
        document.querySelectorAll('#price-pane tr.from-project').forEach(tr => tr.classList.remove('from-project', 'needs-check'));

        // нейросеть может вернуть одну работу несколькими строками — складываем
        const merged = new Map();
        for (const item of result.items) {
            const prev = merged.get(item.n);
            if (!prev) { merged.set(item.n, { ...item }); continue; }
            prev.qty += item.qty;
            prev.source = [prev.source, item.source].filter(Boolean).join('; ');
            prev.comment = [prev.comment, item.comment].filter(Boolean).join(' ');
            if (item.confidence === 'low') prev.confidence = 'low';
        }

        const filled = [];
        const lost = [];
        for (const item of merged.values()) {
            const tr = rows.get(item.n);
            if (!tr) { lost.push(item); continue; }
            const input = tr.querySelector('.qty-input');
            input.value = String(item.qty);
            tr.classList.add('from-project');
            tr.classList.toggle('needs-check', item.confidence === 'low');
            tr.closest('details').open = true;
            filled.push({
                item,
                name: tr.cells[1].childNodes[0].textContent.trim(),
                unit: tr.cells[2].textContent,
                sum: Number(tr.dataset.price) * item.qty,
            });
        }
        window.updateRowSums();
        const total = filled.reduce((s, f) => s + f.sum, 0);
        const unmatched = result.unmatched.concat(lost.map(i => ({ name: i.source, qty: i.qty, unit: '', reason: 'Работа №' + i.n + ' не найдена на странице.' })));
        const toCheck = filled.filter(f => f.item.confidence === 'low');

        // отчёт в окне
        resultEl.replaceChildren();
        resultEl.append(el('p', 'project-summary', 'Заполнено позиций: ' + filled.length + '. Сумма по проекту: ' + formatRub(total) + '.'));
        if (unmatched.length) resultEl.append(listBlock('Нет в калькуляторе — добавьте в прайс', 'project-unmatched', unmatched.map(unmatchedLine)));
        if (toCheck.length) resultEl.append(listBlock('Проверьте сопоставление', 'project-check', toCheck.map(filledLine)));
        if (filled.length) {
            const details = el('details', 'project-details');
            details.append(el('summary', '', 'Все заполненные позиции (' + filled.length + ')'));
            details.append(listBlock('', '', filled.map(filledLine)));
            resultEl.append(details);
        }
        if (result.skipped.length) {
            const details = el('details', 'project-details');
            details.append(el('summary', '', 'Не посчитано как отдельная работа (' + result.skipped.length + ')'));
            details.append(listBlock('', '', result.skipped.map(s => [s.name, s.reason])));
            resultEl.append(details);
        }
        if (result.notes) resultEl.append(el('p', 'project-notes', 'Замечания: ' + result.notes));
        if (result.usage && result.usage.cost_rub != null) {
            resultEl.append(el('p', 'project-cost', 'Стоимость этого расчёта в Polza.ai: ' + Number(result.usage.cost_rub).toFixed(2) + ' ₽'));
        }
        resultEl.hidden = false;

        // короткая сводка над итогом калькулятора
        reportEl.replaceChildren();
        reportEl.append(el('h4', '', 'Расчёт по проекту: ' + filled.length + ' поз., ' + formatRub(total)));
        if (unmatched.length) reportEl.append(listBlock('Нет в калькуляторе — добавьте в прайс', 'project-unmatched', unmatched.map(unmatchedLine)));
        if (toCheck.length) reportEl.append(listBlock('Проверьте сопоставление', 'project-check', toCheck.map(filledLine)));
        if (result.notes) reportEl.append(el('p', 'project-notes', 'Замечания: ' + result.notes));
        const again = el('button', 'reset-btn', 'Открыть отчёт');
        again.type = 'button';
        again.addEventListener('click', () => dialog.showModal());
        reportEl.append(again);
        reportEl.hidden = false;
    }

    function unmatchedLine(u) {
        const qty = u.qty != null ? ' — ' + formatQty(u.qty) + (u.unit ? ' ' + u.unit : '') : '';
        return [u.name + qty, u.reason];
    }

    function filledLine(f) {
        const head = '№' + f.item.n + ' ' + f.name + ' — ' + formatQty(f.item.qty) + ' ' + f.unit + ' = ' + formatRub(f.sum);
        return [head, [f.item.source, f.item.comment].filter(Boolean).join('. ')];
    }

    function listBlock(title, className, lines) {
        const box = el('div', className);
        if (title) box.append(el('h5', '', title));
        const ul = el('ul');
        for (const [main, sub] of lines) {
            const li = el('li', '', main);
            if (sub) li.append(el('small', '', sub));
            ul.append(li);
        }
        box.append(ul);
        return box;
    }

    // --- отправка -----------------------------------------------------------

    async function run() {
        const password = $('projectPassword').value;
        const files = [...$('projectFiles').files];
        if (!password) throw new Error('Введите пароль.');
        if (!files.length) throw new Error('Выберите файлы проекта.');

        const parts = [];
        for (const file of files) {
            setStatus('Читаю «' + file.name + '»…');
            parts.push(...await fileToParts(file, $('projectPages').value));
        }
        const images = parts.filter(p => p.type === 'image').length;
        if (images > MAX_IMAGES) {
            throw new Error('Получилось ' + images + ' страниц и изображений, а за один расчёт можно не более ' + MAX_IMAGES
                + '. Укажите в поле «Страницы PDF» только листы со спецификацией.');
        }
        if (!parts.some(p => p.type === 'image' || p.text.trim())) throw new Error('В выбранных файлах не нашлось текста.');

        setStatus('Отправляю в нейросеть. Обычно расчёт занимает 20–90 секунд…');
        let response;
        try {
            response = await fetch('estimate.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, parts }),
            });
        } catch (e) {
            throw new Error('Нет связи с сайтом. Проверьте интернет и попробуйте ещё раз.');
        }
        let data = null;
        try { data = await response.json(); } catch (e) { /* хостинг вернул не JSON */ }
        if (!data) {
            throw new Error(response.status === 413
                ? 'Файлы слишком большие для хостинга. Загрузите меньше страниц.'
                : 'Сайт вернул ошибку ' + response.status + '. Попробуйте ещё раз или загрузите меньше страниц.');
        }
        if (!data.ok) {
            if (response.status === 401) $('projectPassword').focus();
            throw new Error(data.error || 'Не удалось выполнить расчёт.');
        }
        applyResult(data);
        setStatus('Готово. Количества подставлены в калькулятор.');
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submitBtn.disabled) return;
        submitBtn.disabled = true;
        resultEl.hidden = true;
        try {
            await run();
        } catch (e) {
            setStatus(e.message || 'Не удалось выполнить расчёт.', true);
        } finally {
            submitBtn.disabled = false;
        }
    });

    $('projectBtn').addEventListener('click', () => {
        dialog.showModal();
        ($('projectPassword').value ? $('projectFiles') : $('projectPassword')).focus();
    });
    $('resetAllBtn').addEventListener('click', () => {
        reportEl.hidden = true;
        document.querySelectorAll('#price-pane tr.from-project').forEach(tr => tr.classList.remove('from-project', 'needs-check'));
    });
    $('projectClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
})();
