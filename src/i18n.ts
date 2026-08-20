// Interface language: Russian or English, chosen in onboarding and switchable
// in Settings.
//
// One flat catalogue, `key: [ru, en]`. Keys are typed, so a missing or
// misspelled one is a compile error rather than a blank label at runtime.
//
// Interpolation: `{name}` placeholders, filled from the `vars` argument.
//
// Plurals: a value may carry its forms separated by `|` — three for Russian
// (one / few / many), two for English (one / other). `t()` picks the form from
// `vars.n`, so call sites never think about grammar:
//   t("lib.covers", { done: 3, total: 12 })
//   t("settings.books", { n: 5 })          → «5 книг» / "5 books"
//
// The chosen language is also the language books are translated INTO: a reader
// who runs Chitallo in Russian wants Russian pages, one who runs it in English
// wants English ones. See TARGET_LANGUAGE.

import { useSyncExternalStore } from "react";

import { isMac, macKeys } from "./host";

export type Lang = "ru" | "en";

const LS_KEY = "pdfer:lang";

// ---- catalogue --------------------------------------------------------------

const S = {
  // -- shared verbs and nouns --
  "ui.close": ["Закрыть (Esc)", "Close (Esc)"],
  "ui.cancel": ["Отмена", "Cancel"],
  "ui.delete": ["Удалить", "Delete"],
  "ui.download": ["Скачать", "Download"],
  "ui.retry": ["Повторить", "Try again"],
  "ui.restart": ["Перезапустить", "Restart"],
  "ui.open": ["Открыть", "Open"],
  "ui.copy": ["Копировать", "Copy"],
  "ui.copied": ["Скопировано", "Copied"],
  "ui.back": ["Назад", "Back"],
  "ui.next": ["Далее", "Next"],
  "ui.skip": ["Пропустить", "Skip"],
  "ui.done": ["Готово", "Done"],
  "ui.none": ["нет", "none"],
  "ui.notFound": ["Ничего не нашлось", "Nothing found"],
  "ui.copyFailed": ["Не удалось скопировать", "Could not copy"],
  "ui.openFolderFailed": ["Не удалось открыть папку", "Could not open the folder"],

  // -- app identity --
  "app.tagline": ["Читалка с локальным переводом", "A reader that translates books locally"],
  "app.privacy": [
    "Работает полностью офлайн. Книги и переводы не покидают ваш компьютер",
    "Works fully offline. Your books and translations never leave this computer",
  ],
  "app.privacyAsk": [
    "Исключение — «Спросить»: вопрос и фрагмент книги отправляются в Claude.",
    "One exception — «Ask»: your question and a fragment of the book go to Claude.",
  ],
  "app.about": ["О Chitallo", "About Chitallo"],
  "app.openFail": [
    "Не удалось открыть файл — он перемещён или повреждён",
    "Could not open the file — it was moved or is damaged",
  ],

  // -- onboarding --
  "ob.langTitle": ["Выберите язык", "Choose your language"],
  "ob.langBody": [
    "На этом языке будет интерфейс — и на него Chitallo будет переводить книги.",
    "This is the language of the interface — and the language Chitallo will translate books into.",
  ],
  "ob.step": ["Шаг {n} из {total}", "Step {n} of {total}"],
  "ob.engineTitle": ["Движок перевода", "Translation engine"],
  "ob.engineFound": ["llama.cpp найден", "llama.cpp found"],
  "ob.engineMissing": ["llama.cpp не найден", "llama.cpp not found"],
  "ob.engineRecheck": ["Проверить снова", "Check again"],
  "ob.engineAfter": [
    "Поставили — нажмите «Проверить снова». Приложение перезапускать не нужно.",
    "Once it is installed, hit «Check again». No need to restart the app.",
  ],
  "ob.weightsTitle": ["Модель перевода", "Translation model"],
  "ob.weightsBody": [
    "Веса модели скачиваются один раз и остаются на компьютере. Дальше перевод работает без интернета.",
    "The model weights download once and stay on your computer. After that, translation needs no internet.",
  ],
  "ob.weightsReady": ["Модель на месте", "Model is in place"],
  "ob.claudeTitle": ["Вопросы по книге", "Questions about the book"],
  "ob.claudeBody": [
    "«Спросить» задаёт вопросы о том, что вы читаете, через Claude Code. Это единственная функция, которой нужен интернет, и она полностью необязательна.",
    "«Ask» answers questions about what you are reading, through Claude Code. It is the only feature that needs the internet, and it is entirely optional.",
  ],
  "ob.claudeFound": ["Claude Code подключён", "Claude Code connected"],
  "ob.claudeMissing": ["Claude Code не найден", "Claude Code not found"],
  "ob.claudeAccount": [
    "Нужна подписка Claude Pro или Max — после установки выполните «claude» в терминале и войдите.",
    "Requires a Claude Pro or Max plan — after installing, run «claude» in a terminal and sign in.",
  ],
  "ob.claudeDocs": ["Инструкция по установке", "Installation guide"],
  "ob.copyCmd": ["Скопировать команду", "Copy the command"],
  "ob.readyTitle": ["Всё готово", "You are set"],
  "ob.readyBody": [
    "Откройте PDF — выделите предложение, и перевод появится рядом. Alt+клик переводит абзац целиком, «Перевод ▾» — всю книгу.",
    "Open a PDF — select a sentence and the translation appears next to it. Alt+click translates a whole paragraph, «Translate ▾» the whole book.",
  ],
  "ob.start": ["Открыть библиотеку", "Open the library"],
  "ob.later": ["Настроить позже", "Set this up later"],
  "ob.skipAll": ["Пропустить настройку", "Skip setup"],
  "ob.rerun": ["Пройти настройку заново", "Run setup again"],

  // -- model status vocabulary (one wording, every surface) --
  "model.title": ["Модель перевода", "Translation model"],
  "model.ready": ["Модель перевода: готова", "Translation model: ready"],
  "model.starting": ["Модель перевода: запускается…", "Translation model: starting…"],
  "model.startingShort": ["Модель запускается… ≈20 с", "Model is starting… ~20 s"],
  "model.dead": ["Модель не отвечает", "The model is not responding"],
  "model.deadRestart": ["Модель не отвечает · Перезапустить", "Model not responding · Restart"],
  "model.notInstalled": [
    "Модель не установлена · Скачать ({size})",
    "Model not installed · Download ({size})",
  ],
  "model.noEngine": ["llama.cpp не установлен · Как поставить", "llama.cpp not installed · How to install"],
  "model.noEngineTitle": ["Нужен llama.cpp", "llama.cpp is required"],
  "model.noEngineBody": [
    "Перевод выполняет llama.cpp — Chitallo его не приносит с собой. Одна команда, и он на месте:",
    "Translation runs on llama.cpp, which Chitallo does not ship. One command installs it:",
  ],
  "model.downloading": ["Модель скачивается · {pct}%", "Downloading the model · {pct}%"],
  "model.downloadingDetail": ["Модель скачивается · {detail}", "Downloading the model · {detail}"],
  "model.downloadingBg": [
    "Модель скачивается — можно читать, скачивание продолжится в фоне.",
    "The model is downloading — you can read meanwhile, it continues in the background.",
  ],
  "model.readyHint": [
    "Модель перевода: готова. Выделите текст или Alt+кликните по абзацу — перевод появится рядом.",
    "Translation model: ready. Select some text, or Alt+click a paragraph, and the translation appears next to it.",
  ],
  "model.pitch": [
    "Chitallo переводит книги локально, без интернета и подписок. Нужна модель перевода — она скачивается один раз и остаётся на компьютере.",
    "Chitallo translates books locally — no internet, no subscription. It needs a translation model, downloaded once and kept on your computer.",
  ],
  "model.pitchShort": [
    "Chitallo переводит книги локально, без интернета и подписок",
    "Chitallo translates books locally — no internet, no subscription",
  ],
  "model.line": ["HY-MT1.5 · {size} · перевод офлайн", "HY-MT1.5 · {size} · offline translation"],
  "model.downloadCta": ["Скачать модель перевода ({size})", "Download the translation model ({size})"],
  "model.resumeCta": ["Продолжить скачивание · {pct}%", "Resume the download · {pct}%"],
  "model.downloadShort": ["Скачать модель", "Download the model"],
  "model.needed": [
    "Для перевода нужна модель — {size}, скачивается один раз, работает офлайн",
    "Translation needs a model — {size}, downloaded once, then offline",
  ],
  "model.neededShort": [
    "Для перевода нужна модель — {size}, скачивается один раз",
    "Translation needs a model — {size}, downloaded once",
  ],
  "model.later": ["Позже — просто читать", "Later — just read"],
  "model.verifying": ["Проверка файла…", "Verifying the file…"],
  "model.noSpace": [
    "Недостаточно места на диске — нужно ещё {size}",
    "Not enough disk space — {size} more is needed",
  ],
  "model.checksum": [
    "Файл повреждён при скачивании — попробуйте ещё раз",
    "The file was damaged during download — please try again",
  ],
  "model.interrupted": [
    "Скачивание прервалось — можно продолжить с того же места",
    "The download stopped — it can resume from where it left off",
  ],
  "model.license": [
    "Модель HY-MT1.5 (Tencent) — лицензия Hunyuan Community: бесплатно, в том числе для коммерческого использования; не действует в ЕС, Великобритании и Южной Корее.",
    "The HY-MT1.5 model (Tencent) is under the Hunyuan Community License: free, commercial use included; not available in the EU, the UK or South Korea.",
  ],
  "model.licenseTerms": ["Условия", "Terms"],
  "model.bgDownload": [
    "Скачивается в фоне — подробности и отмена",
    "Downloading in the background — details and cancel",
  ],

  // -- library --
  "lib.title": ["Библиотека", "Library"],
  "lib.pick": ["Выбрать папку с книгами", "Choose a folder with books"],
  "lib.pickNested": ["Включая все вложенные папки", "Subfolders included"],
  "lib.changeFolder": ["Сменить папку", "Change folder"],
  "lib.pickOther": ["Выбрать другую папку", "Choose another folder"],
  "lib.covers": ["Обложки: {done} из {total}", "Covers: {done} of {total}"],
  "lib.search": ["Найти книгу…", "Find a book…"],
  "lib.scanning": ["Поиск PDF…", "Looking for PDFs…"],
  "lib.empty": ["В этой папке не нашлось PDF", "No PDFs in this folder"],
  "lib.reading": ["Читаю", "Reading"],
  "lib.all": ["Все книги", "All books"],
  "lib.hint": [
    "Выделите текст — {tr} · Alt+клик — абзац · {t} — перевод/оригинал",
    "Select text — {tr} · Alt+click — paragraph · {t} — translation/original",
  ],
  "lib.hintHide": ["Скрыть подсказку", "Hide this hint"],
  "lib.translating": ["Книга переводится", "Translating this book"],
  "lib.stalled": [
    "Модель недоступна — перевод приостановлен, готовые страницы сохранены",
    "The model is unavailable — translation paused, finished pages are saved",
  ],

  // -- toolbar / reader --
  "tb.library": ["Библиотека", "Library"],
  "tb.libraryEsc": ["Библиотека (Esc)", "Library (Esc)"],
  "tb.openFile": ["Открыть файл", "Open a file"],
  "tb.openFileKey": ["Открыть файл (Ctrl+O)", "Open a file (Ctrl+O)"],
  "tb.pageAndToc": ["Страница и оглавление", "Page and contents"],
  "tb.zoomOut": ["Мельче (Ctrl −, Ctrl+0 — по ширине)", "Zoom out (Ctrl −, Ctrl+0 fits width)"],
  "tb.zoomIn": ["Крупнее (Ctrl +, Ctrl+0 — по ширине)", "Zoom in (Ctrl +, Ctrl+0 fits width)"],
  "tb.zoomPresets": ["Масштаб: пресеты (Ctrl+0 — по ширине)", "Zoom presets (Ctrl+0 fits width)"],
  "tb.fitWidth": ["По ширине", "Fit width"],
  "tb.fitPage": ["Страница целиком", "Whole page"],
  "tb.col1": ["Одна страница в ряд (Ctrl+1)", "One page per row (Ctrl+1)"],
  "tb.col2": ["Две страницы в ряд (Ctrl+2)", "Two pages per row (Ctrl+2)"],
  "tb.colAuto": ["Автоподбор по ширине (Ctrl+3)", "Fit as many as fit (Ctrl+3)"],
  "tb.dark": ["Тёмная тема (D)", "Dark theme (D)"],
  "tb.light": ["Светлая тема (D)", "Light theme (D)"],
  "tb.settingsKey": ["Настройки (Ctrl+,)", "Settings (Ctrl+,)"],
  "tb.ask": ["Спросить", "Ask"],
  "tb.askTitle": ["Вопросы по книге (Ctrl+J)", "Questions about this book (Ctrl+J)"],
  "tb.original": ["Оригинал", "Original"],
  "tb.translation": ["Перевод", "Translation"],
  "tb.originalKey": ["Оригинал (T)", "Original (T)"],
  "tb.translationKey": ["Перевод (T)", "Translation (T)"],
  "tb.trMenu": ["Перевод книги", "Translate the book"],

  // -- translation menu --
  "tr.updating": ["Обновление · {pct}%", "Updating · {pct}%"],
  "tr.modelGone": [" · модель недоступна", " · model unavailable"],
  "tr.pause": ["Приостановить", "Pause"],
  "tr.pagesKept": ["Готовые страницы сохраняются", "Finished pages are being saved"],
  "tr.noTextLayer": ["В книге нет текстового слоя — нужен OCR", "This book has no text layer — it needs OCR"],
  "tr.startTitle": [
    "Вся книга переводится офлайн, на вашем компьютере. Можно прервать в любой момент",
    "The whole book is translated offline, on your computer. You can stop at any time",
  ],
  "tr.start": ["Перевести книгу", "Translate the book"],
  "tr.resumeTitle": [
    "Продолжить перевод (готово {done} из {total} страниц)",
    "Resume translating ({done} of {total} pages done)",
  ],
  "tr.resume": ["Продолжить перевод · {pct}%", "Resume translating · {pct}%"],
  "tr.complete": ["Книга переведена", "The book is translated"],
  "tr.updateTitle": [
    "Пересобрать структуру страниц и доперевести только изменившееся",
    "Rebuild the page structure and re-translate only what changed",
  ],
  "tr.update": ["Обновить перевод", "Update the translation"],
  "tr.updateResume": ["Продолжить обновление · {pct}%", "Resume the update · {pct}%"],
  "tr.redoWarn": ["Готовый перевод будет удалён", "The finished translation will be deleted"],
  "tr.redoConfirm": ["Удалить и перевести заново", "Delete and translate again"],
  "tr.redoTitle": [
    "Удалить готовый перевод и перевести книгу заново",
    "Delete the finished translation and translate the book from scratch",
  ],
  "tr.redo": ["Перевести заново", "Translate again"],
  "tr.pdfPreparing": ["Подготовка PDF…", "Preparing the PDF…"],
  "tr.pdfPreparingPct": ["Подготовка PDF… {pct}%", "Preparing the PDF… {pct}%"],
  "tr.exportPdfTitle": [
    "Сохранить перевод в PDF с иллюстрациями оригинала — файл появится в папке «Загрузки»",
    "Save the translation as a PDF with the original illustrations — it lands in your Downloads folder",
  ],
  "tr.exportPdf": ["Экспорт в PDF", "Export to PDF"],
  "tr.exportPartial": ["Готово {done} из {total} страниц", "{done} of {total} pages done"],
  "tr.exportHtmlTitle": [
    "Сохранить перевод в HTML — файл появится в папке «Загрузки»",
    "Save the translation as HTML — it lands in your Downloads folder",
  ],
  "tr.exportHtml": ["Экспорт в HTML", "Export to HTML"],
  "tr.exporting": ["Экспорт… {pct}%", "Exporting… {pct}%"],
  "tr.savedToDownloads": ["Сохранено в Загрузки", "Saved to Downloads"],
  "tr.exportFailed": ["Не удалось экспортировать перевод", "Could not export the translation"],
  "tr.pdfFailed": ["Не удалось сохранить PDF", "Could not save the PDF"],
  "tr.pdfUnsupported": [
    "Экспорт в PDF на этой системе недоступен — попробуйте HTML",
    "PDF export is not available on this system — try HTML instead",
  ],
  "tr.saved": ["Перевод сохранён", "Translation saved"],
  "tr.glossaryTitle": [
    "Термины книги и их переводы — используются при переводе",
    "The book's terms and their translations — applied while translating",
  ],
  "tr.glossary": ["Глоссарий…", "Glossary…"],
  "tr.needTranslated": ["Сначала переведите книгу — Перевод ▾", "Translate the book first — Translate ▾"],
  "tr.modelStalled": [
    "Модель недоступна — перевод приостановлен, готовые страницы сохранены",
    "The model is unavailable — translation paused, finished pages are saved",
  ],
  "tr.modelWarming": [
    "Модель запускается… Перевод начнётся автоматически",
    "The model is starting… translation will begin on its own",
  ],
  "tr.etaMin": [" · осталось ~{n} мин", " · ~{n} min left"],
  "tr.etaMinSub": [" · осталось <1 мин", " · <1 min left"],
  "tr.etaHour": [" · осталось ~{n} ч", " · ~{n} h left"],
  "tr.untitled": ["перевод", "translation"],

  // -- selection bar & popover --
  "sel.originalTitle": ["Оригинал выделенного (O)", "Original of the selection (O)"],
  "sel.translateTitle": ["Перевести выделенное (Enter)", "Translate the selection (Enter)"],
  "sel.translate": ["Перевести", "Translate"],
  "sel.askTitle": ["Спросить Claude об этом фрагменте", "Ask Claude about this fragment"],
  "pop.failed": ["Не удалось перевести. Попробуйте ещё раз", "Translation failed. Please try again"],
  "pop.altHint": ["Alt+клик по абзацу — перевод целиком", "Alt+click a paragraph to translate all of it"],

  // -- glossary modal --
  "gl.title": ["Глоссарий", "Glossary"],
  "gl.placeholder": [
    "attention = внимание\nпо одной паре на строку",
    "attention = attention\none pair per line",
  ],
  "gl.replaceWarn": [
    "Список будет заменён, ручные правки пропадут",
    "The list will be replaced and manual edits lost",
  ],
  "gl.replace": ["Заменить", "Replace"],
  "gl.rebuildTitle": [
    "Пересобрать глоссарий с нуля — текущий список будет заменён (с подтверждением)",
    "Rebuild the glossary from scratch — the current list is replaced (you will be asked first)",
  ],
  "gl.buildTitle": [
    "Найти термины во всей книге и перевести их локальной моделью",
    "Find the book's terms and translate them with the local model",
  ],
  "gl.rebuild": ["Собрать заново", "Rebuild"],
  "gl.build": ["Собрать глоссарий", "Build the glossary"],
  "gl.mainModelNote": [
    "Термины переведены основной моделью — качество может быть ниже",
    "Terms were translated by the main model — quality may be lower",
  ],
  "gl.estimate": ["~2–3 мин, поиск терминов по всей книге", "~2–3 min, scanning the whole book for terms"],
  "gl.added": ["Добавлено: {n}", "Added: {n}"],
  "gl.skipped": [" · не переведено: {n}", " · not translated: {n}"],
  "gl.mining": ["Поиск терминов… {done}/{total}", "Finding terms… {done}/{total}"],
  "gl.loading": ["Загрузка модели… (до 30 с)", "Loading the model… (up to 30 s)"],
  "gl.translating": ["Перевод терминов… {done}/{total}", "Translating terms… {done}/{total}"],
  "gl.stopTitle": [
    "Остановить — уже переведённые термины будут добавлены",
    "Stop — the terms already translated will be kept",
  ],
  "gl.stop": ["Отменить", "Stop"],
  "gl.noTerms": [
    "В книге не нашлось характерных терминов",
    "No characteristic terms were found in this book",
  ],
  "gl.failed": ["Не удалось собрать глоссарий. Попробуйте ещё раз", "Could not build the glossary. Please try again"],
  "gl.retranslateTitle": [
    "Удалить сохранённый перевод книги и перевести заново с текущим глоссарием",
    "Delete the saved translation and translate again with the current glossary",
  ],
  "gl.retranslate": ["Перевести заново", "Translate again"],
  "gl.auxProgress": ["Дополнительная модель: {detail}", "Extra model: {detail}"],
  "gl.auxPitch": [
    "Перевод терминов точнее с дополнительной моделью — {size}, лицензия Apache-2.0",
    "Term translation is sharper with an extra model — {size}, Apache-2.0 licensed",
  ],
  "gl.auxResume": ["Продолжить · {pct}%", "Resume · {pct}%"],

  // -- find bar --
  "find.placeholder": ["Найти в книге", "Find in this book"],
  "find.nothing": ["Не найдено", "No matches"],
  "find.prev": ["Предыдущее совпадение (Shift+Enter)", "Previous match (Shift+Enter)"],
  "find.next": ["Следующее совпадение (Enter)", "Next match (Enter)"],

  // -- outline / go to page --
  "out.pagePlaceholder": ["Страница 1–{last}", "Page 1–{last}"],
  "out.pageLabel": ["Номер страницы", "Page number"],
  "out.noToc": ["В книге нет оглавления", "This book has no table of contents"],

  // -- command palette --
  "pal.page": ["Страница {n}", "Page {n}"],
  "pal.bookTag": ["книга", "book"],
  "pal.findQ": ["Найти: «{q}»", "Find: “{q}”"],
  "pal.placeholder": ["Команда, страница или книга…", "Command, page or book…"],
  "pal.placeholderNoDoc": ["Команда или книга…", "Command or book…"],

  // -- command palette entries + context menu --
  "cmd.toc": ["Оглавление", "Contents"],
  "cmd.find": ["Найти в книге", "Find in this book"],
  "cmd.showOriginal": ["Показать оригинал", "Show the original"],
  "cmd.showTranslation": ["Показать перевод", "Show the translation"],
  "cmd.originalSel": ["Оригинал выделенного", "Original of the selection"],
  "cmd.pauseTr": ["Приостановить перевод", "Pause translating"],
  "cmd.translateBook": ["Перевести книгу", "Translate the book"],
  "cmd.resumeTr": ["Продолжить перевод · {pct}%", "Resume translating · {pct}%"],
  "cmd.zoomIn": ["Крупнее", "Zoom in"],
  "cmd.zoomOut": ["Мельче", "Zoom out"],
  "cmd.col1": ["Одна страница в ряд", "One page per row"],
  "cmd.col2": ["Две страницы в ряд", "Two pages per row"],
  "cmd.colAuto": ["Автоподбор по ширине", "Fit as many as fit"],
  "cmd.histBack": ["Назад по переходам", "Back through jumps"],
  "cmd.histFwd": ["Вперёд по переходам", "Forward through jumps"],
  "cmd.openFile": ["Открыть файл…", "Open a file…"],
  "cmd.lightTheme": ["Светлая тема", "Light theme"],
  "cmd.darkTheme": ["Тёмная тема", "Dark theme"],
  "cmd.keys": ["Клавиши", "Keyboard"],
  "cmd.settings": ["Настройки…", "Settings…"],
  "ctx.revealInFolder": ["Показать в папке", "Reveal in folder"],
  "ctx.addToGlossary": ["Добавить в глоссарий", "Add to the glossary"],
  "ctx.openInBrowser": ["Открыть в браузере", "Open in the browser"],
  "ctx.copyLink": ["Копировать ссылку", "Copy the link"],
  "ctx.originalPara": ["Оригинал абзаца", "Original of the paragraph"],
  "ctx.translatePara": ["Перевести абзац", "Translate this paragraph"],

  // -- shortcuts overlay --
  "keys.title": ["Клавиши", "Keyboard"],
  "keys.wheel": ["колесо", "wheel"],
  "keys.click": ["клик", "click"],
  "keys.reading": ["Чтение", "Reading"],
  "keys.view": ["Вид", "View"],
  "keys.book": ["Книга", "Book"],
  "keys.translation": ["Перевод", "Translation"],
  "keys.screenFwd": ["Экран вперёд", "Screen forward"],
  "keys.screenBack": ["Экран назад", "Screen back"],
  "keys.scroll": ["Прокрутка", "Scroll"],
  "keys.ends": ["Начало и конец книги", "Start and end of the book"],
  "keys.jumps": ["Назад и вперёд по переходам", "Back and forward through jumps"],
  "keys.zoom": ["Масштаб", "Zoom"],
  "keys.fitWidth": ["По ширине", "Fit width"],
  "keys.columns": ["Колонки: одна, две, авто", "Columns: one, two, auto"],
  "keys.darkTheme": ["Тёмная тема", "Dark theme"],
  "keys.palette": ["Палитра команд", "Command palette"],
  "keys.find": ["Найти в книге", "Find in this book"],
  "keys.openFile": ["Открыть файл", "Open a file"],
  "keys.settings": ["Настройки", "Settings"],
  "keys.close": ["Закрыть", "Close"],
  "keys.keys": ["Клавиши", "Keyboard"],
  "keys.trToggle": ["Перевод / оригинал", "Translation / original"],
  "keys.trPara": ["Перевод абзаца", "Translate a paragraph"],
  "keys.origSel": ["Оригинал выделенного", "Original of the selection"],
  "keys.trSel": ["Перевести выделенное", "Translate the selection"],
  "keys.ask": ["Спросить", "Ask"],
  "keys.askQuick": ["Быстрые команды в «Спросить»", "Quick commands in «Ask»"],

  // -- settings --
  "set.title": ["Настройки", "Settings"],
  "set.theme": ["Тема", "Theme"],
  "set.dark": ["Тёмная", "Dark"],
  "set.light": ["Светлая", "Light"],
  "set.language": ["Язык", "Language"],
  "set.trFont": ["Размер текста перевода", "Translated text size"],
  "set.trFontTitle": [
    "Кегль текста в режиме «Перевод» при масштабе 100%",
    "Type size in «Translation» mode at 100% zoom",
  ],
  "set.reset": ["Сбросить", "Reset"],
  "set.libFolder": ["Папка библиотеки", "Library folder"],
  "set.noFolder": ["не выбрана", "not chosen"],
  "set.change": ["Сменить", "Change"],
  "set.models": ["Модели", "Models"],
  "set.modelTr": ["Перевод", "Translation"],
  "set.modelTrDesc": ["HY-MT1.5 · перевод книг", "HY-MT1.5 · book translation"],
  "set.modelTrConfirm": [
    "Файл модели будет удалён с диска — перевод перестанет работать до повторного скачивания",
    "The model file will be deleted — translation stops working until you download it again",
  ],
  "set.modelTerms": ["Термины", "Terms"],
  "set.modelTermsDesc": ["Qwen3.5 · глоссарий", "Qwen3.5 · glossary"],
  "set.modelTermsConfirm": [
    "Файл модели будет удалён с диска",
    "The model file will be deleted from disk",
  ],
  "set.engine": ["Движок", "Engine"],
  "set.engineReady": ["llama.cpp: найден", "llama.cpp: found"],
  "set.engineMissing": ["llama.cpp: не найден", "llama.cpp: not found"],
  "set.claude": ["Claude Code", "Claude Code"],
  "set.claudeReady": ["подключён", "connected"],
  "set.claudeMissing": ["не найден", "not found"],
  "set.howToInstall": ["Как поставить", "How to install"],
  "set.onDisk": ["{size} на диске", "{size} on disk"],
  "set.notInstalled": ["не установлена", "not installed"],
  "set.downloaded": ["скачано {pct}%", "{pct}% downloaded"],
  "set.resume": ["Продолжить", "Resume"],
  "set.deleteBusy": [
    "Идёт скачивание — сначала отмените его",
    "A download is running — cancel it first",
  ],
  "set.deleteFail": [
    "Не удалось удалить — файл занят другим процессом",
    "Could not delete — another process is holding the file",
  ],
  "set.storage": ["Хранилище", "Storage"],
  "set.translations": ["Переводы книг", "Book translations"],
  "set.books": ["{n} книга|{n} книги|{n} книг", "{n} book|{n} books"],
  "set.collapse": ["Свернуть", "Collapse"],
  "set.byBook": ["По книгам", "By book"],
  "set.clear": ["Очистить", "Clear"],
  "set.busyTr": [
    "Идёт перевод книги — сначала приостановите его",
    "A book is being translated — pause it first",
  ],
  "set.clearAllWarn": ["Все сохранённые переводы будут удалены", "Every saved translation will be deleted"],
  "set.clearAll": ["Удалить переводы", "Delete the translations"],
  "set.clearOneWarn": ["Перевод книги будет удалён", "This book's translation will be deleted"],
  "set.clearOne": ["Удалить перевод", "Delete the translation"],
  "set.exportTxtRow": ["Перевод открытой книги", "Translation of the open book"],
  "set.exportTxtTitle": [
    "Сохранить перевод простым текстом — без картинок и вёрстки; папку и имя спросит диалог",
    "Save the translation as plain text — no images, no layout; a dialog asks where",
  ],
  "set.exportTxt": ["Экспорт в TXT…", "Export to TXT…"],
  "set.covers": ["Обложки библиотеки", "Library covers"],
  "set.coversTitle": ["Создаются заново при открытии библиотеки", "Rebuilt when the library opens"],
  "set.setup": ["Настройка", "Setup"],

  // -- about --
  "about.title": ["О программе", "About"],
  "about.thirdParty": ["Сторонние компоненты", "Third-party components"],
  "about.hyLicense": [
    "Бесплатно, в том числе для коммерческого использования; не действует в ЕС, Великобритании и Южной Корее",
    "Free, commercial use included; not available in the EU, the UK or South Korea",
  ],
  "about.modelHy": ["Модель HY-MT1.5-7B · Tencent", "HY-MT1.5-7B model · Tencent"],
  "about.modelQwen": ["Модель Qwen3.5-4B · Alibaba", "Qwen3.5-4B model · Alibaba"],

  // -- ask sidebar --
  "ask.appOnlyBadge": ["Доступно только в приложении", "Available only in the app"],
  "ask.empty": [
    "Выделите фрагмент и нажмите «Спросить» — или задайте вопрос о книге здесь",
    "Select a fragment and hit «Ask» — or just ask about the book here",
  ],
  "ask.quotePagePrefix": ["стр. {n} — ", "p. {n} — "],
  "ask.threads": ["Беседы по книге", "Conversations about this book"],
  "ask.threadsN": ["Беседы по книге · {n}", "Conversations about this book · {n}"],
  "ask.threadsHeading": ["Беседы", "Conversations"],
  "ask.threadsEmpty": [
    "Здесь появятся беседы по этой книге",
    "Conversations about this book will show up here",
  ],
  "ask.newThreadTitle": ["Новая беседа", "New conversation"],
  "ask.newThreadEmpty": [
    "Новая беседа — эта беседа уже пустая",
    "New conversation — this one is already empty",
  ],
  "ask.closeKey": ["Закрыть (Ctrl+J)", "Close (Ctrl+J)"],
  "ask.deleteThread": ["Удалить беседу", "Delete this conversation"],
  "ask.deleteThreadWarn": [
    "Беседа и её память будут удалены",
    "The conversation and its memory will be deleted",
  ],
  "ask.hideSuggestions": ["Скрыть подсказки", "Hide the suggestions"],
  "ask.removeFragment": ["Убрать фрагмент", "Remove the fragment"],
  "ask.cmdNotFound": ["Команда не найдена", "No such command"],
  "ask.placeholder": ["Вопрос по книге… «/» — команды", "A question about the book… «/» for commands"],
  "ask.quickCommands": ["Быстрые команды (/)", "Quick commands (/)"],
  "ask.quickCommandsShort": ["Быстрые команды", "Quick commands"],
  "ask.stop": ["Остановить", "Stop"],
  "ask.send": ["Отправить (Enter)", "Send (Enter)"],
  "ask.stopped": ["(остановлено)", "(stopped)"],
  "ask.pageShort": ["стр. {n}: ", "p. {n}: "],
  "ask.title": ["Вопросы по книге", "Questions about this book"],
  "ask.newThread": ["Новая беседа", "New conversation"],
  "ask.emptyThread": ["пусто", "empty"],
  "ask.msgs": ["{n} сообщение|{n} сообщения|{n} сообщений", "{n} message|{n} messages"],
  "ask.today": ["Сегодня", "Today"],
  "ask.yesterday": ["Вчера", "Yesterday"],
  "ask.earlier": ["Раньше", "Earlier"],
  "ask.defaultQ": ["Объясни этот фрагмент", "Explain this fragment"],
  "ask.simpler": ["Объясни проще", "Explain it more simply"],
  "ask.example": ["Приведи пример", "Give an example"],
  "ask.linkTopic": ["Связь с темой", "Link to the topic"],
  "ask.linkTopicMsg": ["Как это связано с темой книги?", "How does this relate to the book's subject?"],
  "ask.cmdExplain": ["Объяснить выделенное", "Explain the selection"],
  "ask.cmdTerm": ["Определить термин", "Define the term"],
  "ask.cmdTermMsg": [
    "Что означает этот термин в контексте книги?",
    "What does this term mean in the context of this book?",
  ],
  "ask.cmdPage": ["Пересказать страницу", "Summarize the page"],
  "ask.cmdPageMsg": ["Перескажи страницу {n} своими словами", "Summarize page {n} in your own words"],
  "ask.cmdLink": ["Связать с темой книги", "Relate it to the book's subject"],
  "ask.cmdSimpler": ["Объяснить проще", "Explain it more simply"],
  // One command, not one per form: the point of ask.viz is that the model picks
  // the shape. «Наглядно» asks for the best one — and explicitly licenses «none
  // of them», so the command cannot be read as an order to draw something.
  "ask.cmdChart": ["Показать наглядно", "Show it visually"],
  "ask.cmdChartMsg": [
    "Покажи содержание страницы {n} наглядно — графиком, схемой или таблицей, смотря что подходит. Если наглядно тут нечего показывать, так и скажи, без картинки.",
    "Show what is on page {n} visually — a chart, a diagram or a table, whichever fits. If there is nothing here worth a picture, say so plainly and draw none.",
  ],
  "ask.needSeed": ["Сначала выделите фрагмент в книге", "Select a fragment in the book first"],
  "ask.needAnswer": ["Сначала задайте вопрос", "Ask a question first"],
  "ask.panelWidth": ["Ширина панели", "Panel width"],
  "ask.panelWidthTitle": [
    "Ширина панели · двойной клик вернёт исходную",
    "Panel width · double-click restores the default",
  ],
  "ask.appOnly": [
    "Вопросы к Claude доступны только в приложении Chitallo",
    "Asking Claude only works inside the Chitallo app",
  ],
  "ask.emptyAnswer": ["(пустой ответ)", "(empty answer)"],
  "ask.errUnknown": ["Ошибка: {what}", "Error: {what}"],
  "ask.errUnknownWhat": ["неизвестная", "unknown"],
  "ask.cancelled": ["Запрос отменён", "Request cancelled"],
  "ask.noAnswer": ["Ответ не получен", "No answer came back"],
  "ask.exited": [
    "Claude Code завершился без ответа ({detail})",
    "Claude Code exited without answering ({detail})",
  ],
  "ask.notFound": [
    "Claude Code не найден ({path}). Поставьте его — и «Спросить» заработает.",
    "Claude Code not found ({path}). Install it and «Ask» starts working.",
  ],
  "ask.busy": [
    "Уже выполняется другой запрос — дождитесь ответа или остановите его",
    "Another request is already running — wait for it or stop it",
  ],
  "ask.launchFail": ["Не удалось запустить Claude: {detail}", "Could not start Claude: {detail}"],
  // The prompt Claude itself receives — written in the reader's language so the
  // answers come back in it.
  "ask.system": [
    "Ты — помощник в PDF-читалке. Пользователь читает книгу «{title}» и задаёт вопросы о ней по-русски. Отвечай на русском, кратко и по существу. Если вопрос про выделенный фрагмент — объясняй именно его в контексте книги. Ссылайся на номера страниц, когда это уместно. Уместна умеренная markdown-разметка (списки, выделение); без заголовков без необходимости.",
    "You are an assistant inside a PDF reader. The user is reading the book “{title}” and asks questions about it in English. Answer in English, briefly and to the point. If the question is about a selected fragment, explain that fragment in the context of the book. Cite page numbers where it helps. Moderate markdown (lists, emphasis) is welcome; avoid headings unless they earn their place.",
  ],
  // Appended to ask.system. Not a list of syntaxes — a rubric for CHOOSING the
  // shape of an answer, whose standing answer is «prose, write a sentence». The
  // syntaxes come after, and each has to agree with the renderer that reads it:
  // maths is KaTeX with single-dollar inline ON, ```chart is parsed by ChartBlock
  // and ```mermaid by MermaidBlock (components/ai-elements/), so the limits
  // quoted here are the limits those files actually enforce.
  //
  // Three deliberate narrowings, each of which cost an answer somewhere:
  //   * five numbers before a chart — the failure this guards is a bar chart of
  //     two values, which every model reaches for;
  //   * four to seven nodes, and only flowchart TD / stateDiagram-v2 /
  //     sequenceDiagram — everything else is unreadable in a 320 px column, and
  //     mindmap is left out on purpose: it is the most tempting WRONG answer to
  //     «what is X», where a nested list is better;
  //   * one picture per answer, after the prose, never instead of it.
  //
  // NB: no «|» anywhere in this string — t() reads a pipe as a plural split and
  // would silently truncate the system prompt at the first one. Guarded below.
  "ask.viz": [
    "Форма ответа. По умолчанию — проза; в девяти случаях из десяти это и есть верный ответ. Правило одно: рисуй только то, чего не скажешь вслух. Если ответ можно произнести собеседнику и он поймёт — пиши словами. Картинка нужна, когда важна не сама величина, а её форма: ход, перевес, ветвление, порядок. Она не заменяет ответ, а идёт после одной-двух фраз прозы; больше одной картинки в ответе почти никогда не нужно. Перед тем как рисовать, мысленно убери картинку: если ответ и без неё полон, она была украшением. Сомневаешься — не рисуй.\n\nНе рисуй график из двух-трёх чисел, круговую диаграмму из долей, уже названных в тексте, схему-пересказ абзаца и формулу вокруг счёта в уме. Числа, шаги и связи бери только из книги или из вопроса и не придумывай их; страницу-источник называй. Прямая просьба нарисовать снимает пороги, но не этот запрет: чего в книге нет, того не рисуй.\n\nФормулы — исключение: это не картинка, а запись, которой пользуется сама книга, и её пиши смело. LaTeX: $E=mc^2$ внутри строки, $$...$$ отдельным блоком. Доллар в обычном тексте экранируй (\\$5), иначе он утащит полабзаца в формулу. Простое число в формулу не оборачивай.\n\nГрафик — когда чисел пять и больше и в них виден ход или сравнение. Два-три числа просто назови словами. Блок кода с языком chart и JSON внутри:\n\n```chart\n{\"type\": \"line\", \"title\": \"Население, млн\", \"x\": \"year\", \"unit\": \"млн\", \"note\": \"с. 214\", \"series\": [{\"key\": \"ru\", \"label\": \"Россия\"}], \"data\": [{\"year\": 1897, \"ru\": 125.6}, {\"year\": 1926, \"ru\": 147}]}\n```\n\ntype — line, area, bar или pie; x — поле категории (ось X, для pie — название доли); series — ряды, у каждого key (поле в data, латиницей, без пробелов) и label; data — массив объектов. Необязательные: title, xLabel (как назвать колонку x в таблице), unit, note (мелкая строка под графиком, обычно страница), stacked, curve (natural, linear, step). Не больше 5 рядов и 5 долей; на одном графике одна величина, две разные шкалы в одних осях врут; pie — только доли целого; числа пиши числами JSON, подписи по-русски.\n\nСхема — когда важны связи, а не количества, и есть развилка или возврат: от четырёх узлов и не больше семи. Прямая цепочка шагов — это список, а не схема. Разбор понятия на части — тоже список. Блок кода с языком mermaid, сверху вниз, и только три типа: flowchart TD — путь с ветвлением; stateDiagram-v2 — состояния и переходы; sequenceDiagram — обмен между двумя-тремя сторонами.\n\n```mermaid\nflowchart TD\n  A[\"Наблюдение\"] --> B[\"Гипотеза\"]\n  B --> C{\"Опыт сошёлся\"}\n  C -- да --> D[\"Закон\"]\n  C -- нет --> A\n```\n\nПодписи в flowchart всегда в кавычках, два-три слова. Направление LR, subgraph, стили, директивы init и остальные типы не пиши: в узкой панели они нечитаемы. Страницу назови прозой рядом со схемой.\n\nТаблица — обычным markdown, когда сравниваешь несколько объектов по нескольким признакам и строк хотя бы три. Две-три колонки и короткие ячейки, шире панель не примет.",
    "Shape of the answer. Prose is the default; nine times in ten it is the whole answer. One rule decides: draw only what you cannot say out loud. If you could say it across the table and be understood, write it in words. A picture is for when the shape matters more than the value — a trend, a gap, a branch, an order. It never stands in for the answer: a sentence or two of prose comes first, and more than one picture in an answer is almost never needed. Before you draw, take the picture away: if the answer is still complete, it was decoration. In doubt, do not draw.\n\nDo not draw a chart of two or three numbers, a pie of shares already listed in the text, a diagram that retells a paragraph with arrows, or maths around a sum you can do in your head. Take every number, step and link from the book or the question, invent none, name the source page. Asked outright for a picture, the thresholds drop but that ban does not: what is not in the book stays undrawn.\n\nMaths is the exception: not a picture but the notation the book itself uses, so write it freely. LaTeX: $E=mc^2$ inline, $$...$$ as its own block. Escape a literal dollar in prose (\\$5) or it will swallow half a paragraph into a formula. Do not wrap a plain number in maths.\n\nChart — five numbers or more, with a trend or a comparison visible in them. Two or three you simply say in words. A code block tagged chart, with JSON inside:\n\n```chart\n{\"type\": \"line\", \"title\": \"Population, millions\", \"x\": \"year\", \"unit\": \"m\", \"note\": \"p. 214\", \"series\": [{\"key\": \"ru\", \"label\": \"Russia\"}], \"data\": [{\"year\": 1897, \"ru\": 125.6}, {\"year\": 1926, \"ru\": 147}]}\n```\n\ntype — line, area, bar or pie; x — the category field (the X axis, or the slice name for pie); series — the series, each with key (the field in data, ASCII, no spaces) and label; data — an array of objects. Optional: title, xLabel (what to call the x column in the table), unit, note (the small line under the chart, usually the page), stacked, curve (natural, linear, step). At most 5 series and 5 slices; one measure per chart, two scales in one pair of axes lie; pie only for parts of a whole; numbers as JSON numbers, labels in English.\n\nDiagram — when links matter more than quantities and there is a fork or a loop back: four nodes at least, seven at most. A straight run of steps is a list, not a diagram. A concept broken into parts is a list too. A code block tagged mermaid, top down, and only three types: flowchart TD — a path that branches; stateDiagram-v2 — states and transitions; sequenceDiagram — an exchange between two or three sides.\n\n```mermaid\nflowchart TD\n  A[\"Observation\"] --> B[\"Hypothesis\"]\n  B --> C{\"Experiment fits\"}\n  C -- yes --> D[\"Law\"]\n  C -- no --> A\n```\n\nNode labels in flowchart are always quoted, two or three words. No LR, no subgraph, no styling, no init directives, no other type: the panel is too narrow. Name the page in prose beside the diagram.\n\nTable — plain markdown, comparing several things across several properties, at least three rows. Two or three columns with short cells, nothing wider fits.",
  ],
  "ask.quoteFrom": [
    "Фрагмент из книги «{title}»{page}:",
    "A fragment from the book “{title}”{page}:",
  ],
  "ask.quotePage": [" (страница {n})", " (page {n})"],
  "ask.surrounding": ["Окружающий текст страницы:", "Surrounding text on the page:"],
  "ask.question": ["Вопрос: {q}", "Question: {q}"],
  "ask.readingCtx": [
    "Читаю книгу «{title}», сейчас открыта страница {page}.",
    "I am reading the book “{title}”, currently on page {page}.",
  ],

  // -- charts Claude draws inside an answer (```chart, see chart-block.tsx) --
  "chart.showTable": ["Показать таблицей", "Show as a table"],
  "chart.showChart": ["Показать графиком", "Show as a chart"],
  "chart.drawing": ["Строится график", "Drawing the chart"],
  "chart.other": ["прочее", "other"],
  "chart.broken": [
    "Claude прислал график, который не удалось прочитать",
    "Claude sent a chart that could not be read",
  ],
  "chart.dropped": [
    "не поместился ещё {n} ряд|не поместились ещё {n} ряда|не поместились ещё {n} рядов",
    "{n} more series did not fit|{n} more series did not fit",
  ],

  // -- diagrams Claude draws inside an answer (```mermaid, see mermaid-block.tsx) --
  "diagram.drawing": ["Строится схема", "Drawing the diagram"],
  "diagram.broken": [
    "Claude прислал схему, которую не удалось прочитать",
    "Claude sent a diagram that could not be read",
  ],

  // -- glossary terminologist (prompts the aux model sees) --
  "term.system": [
    "Ты — терминолог. Тебе дают термин из книги, тематику книги и предложение-контекст. Ответь ТОЛЬКО устоявшимся русским эквивалентом этого термина — без пояснений, без кавычек, без точки в конце. Если термин по общепринятой конвенции не переводится (аббревиатура, имя собственное, название продукта или компании) — верни его без изменений.",
    "You are a terminologist. You are given a term from a book, the book's subject area, and a sentence of context. Answer with ONLY the established English equivalent of that term — no explanation, no quotes, no full stop. If convention leaves the term untranslated (an acronym, a proper name, a product or company name), return it unchanged.",
  ],
  "term.domain": ["Тематика книги (ключевые термины): {domain}", "Subject area (key terms): {domain}"],
  "term.context": ["Контекст: {sample}", "Context: {sample}"],
  "term.term": ["Термин: {term}", "Term: {term}"],

  // -- export document (the generated HTML/PDF) --
  "exp.machineTr": ["Машинный перевод · Chitallo{partial}", "Machine translation · Chitallo{partial}"],
  "exp.partial": [
    " · готово {done} из {total} страниц",
    " · {done} of {total} pages done",
  ],
  "exp.pageNotTr": ["страница {n} не переведена", "page {n} is not translated"],
  "exp.pagesNotTr": ["страницы {a}–{b} не переведены", "pages {a}–{b} are not translated"],
  "exp.refPage": ["страница {n} — оригинал без перевода", "page {n} — original, untranslated"],
  "exp.placeholder": ["[таблица или формула]", "[table or formula]"],
  "exp.origPage": ["Страница {n} оригинала", "Page {n} of the original"],
  "exp.figure": ["Рисунок", "Figure"],
  "exp.fragment": ["Фрагмент оригинала", "Fragment of the original"],
  "exp.docTitle": ["{title} — перевод", "{title} — translation"],
  "exp.txtFilter": ["Текст", "Text"],
} as const satisfies Record<string, readonly [string, string]>;

export type Key = keyof typeof S;

// A pipe in a catalogue entry means «plural forms», and t() splits on it before
// it does anything else — so one typed into ordinary prose silently truncates
// that string to its first «form». Nowhere does that hurt more than ask.viz,
// which is a multi-paragraph system prompt: the model would receive it cut off
// mid-sentence and nothing would look broken. Every real plural here counts with
// {n}, so an entry with a pipe and no {n} is the mistake, caught in dev, at
// import time, before anything renders.
if (import.meta.env.DEV) {
  for (const [key, forms] of Object.entries(S)) {
    for (const s of forms) {
      if (s.includes("|") && !s.includes("{n}")) {
        throw new Error(
          `i18n: «${key}» contains a pipe but no {n} — t() will split it into plural forms and drop everything after the first one.`,
        );
      }
    }
  }
}

// ---- language state ---------------------------------------------------------

/// The reader has never chosen: onboarding decides, and until it does nothing
/// should silently guess and stick.
export function chosenLang(): Lang | null {
  const v = localStorage.getItem(LS_KEY);
  return v === "ru" || v === "en" ? v : null;
}

/// Best guess before a choice exists — used for the onboarding screen itself,
/// so the very first sentence is already in a language the reader can read.
function guessLang(): Lang {
  const tags = typeof navigator === "undefined" ? [] : [navigator.language, ...(navigator.languages ?? [])];
  return tags.some((t) => typeof t === "string" && t.toLowerCase().startsWith("ru")) ? "ru" : "en";
}

let current: Lang = chosenLang() ?? guessLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  localStorage.setItem(LS_KEY, l);
  if (l === current) return;
  current = l;
  document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

/// Subscribing anywhere in the tree re-renders that subtree on a language
/// switch. App does it once at the root, which covers everything below it.
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

if (typeof document !== "undefined") document.documentElement.lang = current;

// ---- lookup -----------------------------------------------------------------

type Vars = Record<string, string | number>;

/// Russian has three plural forms, English two. `n` in the vars picks one.
function pluralIndex(n: number, lang: Lang, forms: number): number {
  if (forms < 2) return 0;
  if (lang === "en") return n === 1 ? 0 : 1;
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return Math.min(2, forms - 1);
}

export function t(key: Key, vars?: Vars): string {
  const entry = S[key] as readonly [string, string];
  let s = current === "ru" ? entry[0] : entry[1];
  if (s.includes("|")) {
    const forms = s.split("|");
    const n = Number(vars?.n ?? 0);
    s = forms[pluralIndex(n, current, forms.length)] ?? forms[0];
  }
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name: string) =>
      name in vars ? String(vars[name as keyof Vars]) : m,
    );
  }
  // Shortcut hints are written once, with the Windows/Linux names, and turned
  // into ⌘/⌥ here — so no string in the catalogue has to spell both.
  return isMac() ? macKeys(s) : s;
}

// ---- numbers ----------------------------------------------------------------

/// Russian writes 4,6; English writes 4.6. One place, so no call site has to
/// remember which.
export function fmtNum(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  return current === "ru" ? s.replace(".", ",") : s;
}

export function fmtGb(bytes: number): string {
  return `${fmtNum(bytes / 1e9)} ${current === "ru" ? "ГБ" : "GB"}`;
}

/// GB / MB / KB, whichever keeps the number readable.
export function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return fmtGb(bytes);
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} ${current === "ru" ? "МБ" : "MB"}`;
  return `${Math.max(1, Math.round(bytes / 1e3))} ${current === "ru" ? "КБ" : "KB"}`;
}

export function fmtMbps(bps: number): string {
  return `${Math.max(1, Math.round(bps / 1e6))} ${current === "ru" ? "МБ/с" : "MB/s"}`;
}

// ---- the language books are translated INTO ---------------------------------
//
// HY-MT1.5's prompt templates name the target language, in English for the
// basic template and in Chinese for the terminology/contextual ones (that is
// how the model card documents them).

export const TARGET_LANGUAGE: Record<Lang, { en: string; zh: string }> = {
  ru: { en: "Russian", zh: "俄语" },
  en: { en: "English", zh: "英语" },
};

export function targetLanguage(): { en: string; zh: string } {
  return TARGET_LANGUAGE[current];
}
