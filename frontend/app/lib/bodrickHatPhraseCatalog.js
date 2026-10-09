const phrase = (id, text, ...variants) => ({ id, text, variants });

export const BODRICK_PHRASE_GROUPS = {
  general: [
    phrase("wild-magic", "Это не баг. Это дикая магия.", "joy", "treacherous"),
    phrase("rent-free", "Я живу здесь. Аренду не плачу.", "joy"),
    phrase(
      "playlist-certified",
      "Плейлист одобрен Бодриком. Сертификат потерялся.",
      "joy"
    ),
    phrase("almost-missed-you", "О! Опять ты. Я уже почти соскучился.", "joy"),
    phrase("good-day", "Музыка играет, шляпа на месте - день удался.", "joy"),
    phrase("adventure", "Вот это уже похоже на приключение!", "joy"),
    phrase("no-fireballs-today", "Сегодня без фаерболов. Наверное.", "joy"),
    phrase(
      "plan-pending",
      "Всё идёт по плану. Я просто ещё не придумал план.",
      "joy"
    ),
    phrase(
      "good-news",
      "Хорошая новость: я всё ещё здесь. Плохую новость пока не нашли.",
      "joy"
    ),
    phrase("stop-poking", "Ты чего шляпу тыкаешь?", "angry"),
    phrase("one-more-click", "Ещё раз нажмёшь - будет фаербол.", "angry"),
    phrase("not-a-summon-button", "Это не кнопка вызова Бодрика.", "angry"),
    phrase("keep-quiet", "Я живу здесь. Веди себя тише.", "angry"),
    phrase("part-of-playlist", "Сейчас кто-то станет частью плейлиста.", "angry"),
    phrase(
      "fixing-the-fix",
      "Не мешай. Я пытаюсь исправить предыдущее исправление.",
      "angry"
    ),
    phrase(
      "magic-resistance",
      "Ещё раз тыкнешь - и мы проверим твою сопротивляемость магии.",
      "angry"
    ),
    phrase(
      "world-too-big",
      "Я не маленький. Это мир неоправданно большой.",
      "angry"
    ),
    phrase(
      "blast-radius-mood",
      "Отойди. У меня сейчас настроение с радиусом поражения.",
      "angry"
    ),
    phrase(
      "alternate-route",
      "Мы не заблудились. Мы исследуем альтернативный маршрут.",
      "angry"
    ),
    phrase("no-fireball", "Фаербола не будет. Наверное.", "treacherous"),
    phrase("bad-plan", "У меня есть план. Уже плохой знак.", "treacherous"),
    phrase("nothing-yet", "Ничего не произошло. Пока.", "treacherous"),
    phrase(
      "portal-responsibility",
      "Шляпа - это портал. А портал - это ответственность. Не моя.",
      "treacherous"
    ),
    phrase(
      "new-idea-retreat",
      "У меня появилась идея. Начинай отходить.",
      "treacherous"
    ),
    phrase(
      "frogs-and-candle",
      "Не спрашивай, зачем мне три лягушки и свеча.",
      "treacherous"
    ),
    phrase(
      "portal-either-way",
      "В худшем случае откроется портал. В лучшем - тоже.",
      "treacherous"
    ),
    phrase(
      "dispelled-magic",
      "Не благодарите. Я рассеял магию. Какую именно - сейчас выясним.",
      "treacherous"
    ),
    phrase(
      "short-long-road",
      "Я знаю короткую дорогу. Она просто очень длинная.",
      "treacherous"
    ),
  ],
  loud: [
    phrase(
      "more-bass",
      "Ещё басов! Я почти нашёл второй этаж шляпы.",
      "joy"
    ),
    phrase(
      "dancing-mugs",
      "Вот это громкость! У меня там кружки по полкам сами пляшут!",
      "joy"
    ),
    phrase(
      "fallen-cauldron",
      "Сделай тише! У меня котёл с потолка упал!",
      "angry"
    ),
    phrase(
      "reading-lips",
      "Понизь громкость. Я из шляпы уже читаю по губам.",
      "angry"
    ),
    phrase(
      "hide-explosion",
      "Погромче, погромче… взрыв тогда никто не заметит.",
      "treacherous"
    ),
    phrase(
      "quiet-spell",
      "На такой громкости никто не услышит, что я тут колдую.",
      "treacherous"
    ),
    phrase(
      "suspicious-sound",
      "Оставь такую громкость. Мне как раз нужно заглушить один подозрительный звук.",
      "treacherous"
    ),
  ],
  muted: [
    phrase("theoretical-music", "Музыка играет. Теоретически.", "joy"),
    phrase(
      "hat-stopped-rattling",
      "Музыки не слышно, зато шляпа наконец перестала дребезжать.",
      "joy"
    ),
    phrase(
      "dance-on-principle",
      "Я всё равно танцую. Это вопрос принципа.",
      "joy"
    ),
    phrase(
      "imagined-part",
      "Играет отлично. Особенно та часть, которую я сам додумал.",
      "joy"
    ),
    phrase(
      "why-play-music",
      "Ты включил музыку, чтобы её не слушать?",
      "angry"
    ),
    phrase(
      "bring-sound-back",
      "Верни звук. Я не для тишины из шляпы вылез.",
      "angry"
    ),
    phrase(
      "only-own-thoughts",
      "Я слышу только собственные мысли. Верни звук!",
      "angry"
    ),
    phrase(
      "start-singing",
      "Ещё немного тишины - и начну петь я.",
      "angry"
    ),
    phrase(
      "sound-downstairs",
      "Где звук? Он провалился на нижний этаж шляпы?",
      "angry"
    ),
    phrase(
      "sound-removed",
      "Звук я убрал не просто так.",
      "treacherous"
    ),
    phrase(
      "track-swap",
      "Без звука никто не заметит подмену трека.",
      "treacherous"
    ),
    phrase(
      "retune-reality",
      "Пока тихо, я немного перенастрою реальность.",
      "treacherous"
    ),
  ],
  low: [
    phrase(
      "almost-silent",
      "Очень атмосферно. Я почти ничего не слышу.",
      "joy"
    ),
    phrase(
      "runaway-cauldron",
      "Вот так хорошо. И трек слышно, и как котёл убегает.",
      "joy"
    ),
    phrase(
      "cozy-volume",
      "Уютная громкость. Можно колдовать, не распугивая мебель.",
      "joy"
    ),
    phrase(
      "player-is-trying",
      "Сделай громче. Плеер старается, между прочим.",
      "angry"
    ),
    phrase(
      "magical-amplification",
      "Верни громкость, пока я не усилил её магически.",
      "angry"
    ),
    phrase(
      "grumbling-louder",
      "Я слышу собственное ворчание громче музыки. Это уже опасно.",
      "angry"
    ),
    phrase(
      "nothing-suspicious",
      "Тихая музыка, тёмный угол, три свечи… ничего подозрительного.",
      "treacherous"
    ),
    phrase(
      "silent-portal",
      "На такой громкости портал открывается почти бесшумно.",
      "treacherous"
    ),
  ],
};
