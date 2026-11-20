/**
 * WoD Initiative Tracker — Foundry VTT v14 (build 370), система WoD20 (JohanFalt).
 * Инициатива = Ловкость (Dexterity) + Восприятие/Смекалка (Wits) + 1d10.
 * Бой состоит из раундов; каждый раунд делится на две стадии:
 *   1. Заявки (Claims)  — обход ОТ МЕНЬШЕЙ инициативы к БОЛЬШЕЙ.
 *      По переключению в чат пишется "<имя>: действие заявлено".
 *   2. Действия (Actions) — обход ОТ БОЛЬШЕЙ инициативы К МЕНЬШЕЙ.
 *      По переключению в чат пишется "<имя>: действие совершено".
 * После завершения стадии действий начинается новый раунд (счётчик раундов
 * виден на панели, начало раунда дублируется сообщением в чат).
 *
 * Дополнительные действия (Multi-action по правилам WoD):
 * у актёра можно указать число доп. действий N. Тогда в стадии ДЕЙСТВИЙ
 * он ходит N+1 раз: сначала на своей полной инициативе, затем каждое
 * следующее действие — с инициативой на -5 меньше предыдущего (классическое
 * правило WoD 20). В стадии ЗАЯВОК такой актёр также декларирует несколько
 * раз (по числу действий), но только свои действия (чужие заявки уже приняты).
 * Порядок очерёдности при этом продолжает подчиняться общим правилам стадий.
 */

const MODULE_ID = "wod-initiative";

/* -------------------------------------------------------------------------- */
/* Хранилище состояния                                                        */
/* -------------------------------------------------------------------------- */

class WodInitiativeState {
  constructor() {
    /** @type {{actorId: string, initiative: number|null, roll: number|null, dex: number|null, wits: number|null, extraActions: number}[]} */
    this.combatants = [];
    this.round = 0;
    /** @type {"idle" | "claims" | "actions"} */
    this.stage = "idle";
    /** Индекс текущего хода в очереди текущей стадии. */
    this.turnIndex = -1;
    /** Кэшированная очередь текущей стадии: [{actorId, slot, value}] */
    this.queue = [];
  }

  static load() {
    const raw = game.settings.get(MODULE_ID, "state");
    const s = new WodInitiativeState();
    if (raw && typeof raw === "object") {
      s.combatants = Array.isArray(raw.combatants) ? raw.combatants : [];
      s.round = Number(raw.round) || 0;
      s.stage = raw.stage || "idle";
      s.turnIndex = Number.isNumeric(raw.turnIndex) ? raw.turnIndex : -1;
    }
    return s;
  }

  save() {
    game.settings.put(MODULE_ID, "state", {
      combatants: this.combatants,
      round: this.round,
      stage: this.stage,
      turnIndex: this.turnIndex,
    });
  }

  getCombatant(actorId) {
    return this.combatants.find((c) => c.actorId === actorId);
  }

  addActor(actorId) {
    if (this.getCombatant(actorId)) return;
    this.combatants.push({
      actorId,
      initiative: null,
      roll: null,
      dex: null,
      wits: null,
      extraActions: 0,
    });
    this.save();
  }

  removeActor(actorId) {
    this.combatants = this.combatants.filter((c) => c.actorId !== actorId);
    if (this.stage !== "idle") this.rebuildQueue();
    this.save();
  }

  setExtraActions(actorId, n) {
    const c = this.getCombatant(actorId);
    if (!c) return;
    c.extraActions = Math.max(0, Math.min(5, Math.floor(n) || 0));
    if (this.stage !== "idle") this.rebuildQueue();
    this.save();
  }

  /* ------------------------- Бросок инициативы ------------------------- */

  async rollInitiative(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const { dex, wits } = readAttributes(actor);
    const roll = new Roll("1d10");
    await roll.evaluate({ async: true });
    const total = dex + wits + roll.total;

    const c = this.getCombatant(actorId);
    c.dex = dex;
    c.wits = wits;
    c.roll = roll.total;
    c.initiative = total;

    // Если бой уже идёт — пересобираем очередь, чтобы учесть новое значение.
    if (this.stage !== "idle") this.rebuildQueue();

    await ChatMessage.create({
      content: game.i18n.format("WODINI.ChatRoll", {
        name: actor.name,
        dex,
        wits,
        roll: roll.total,
        total,
      }),
      sound: CONFIG.SOUNDS.DICE_ROLL,
    });

    this.save();
  }

  /* ----------------------------- Очередь ------------------------------ */

  /** Все участники, у которых брошена инициатива. */
  rolledCombatants() {
    return this.combatants.filter((c) => typeof c.initiative === "number");
  }

  allRolled() {
    return (
      this.combatants.length > 0 &&
      this.combatants.every((c) => typeof c.initiative === "number")
    );
  }

  /**
   * Строит очередь для текущей стадии.
   *
   * Multi-action (дополнительные действия): актёр с N доп. действий имеет
   * N+1 действий в раунде, и каждое следующее идёт с инициативой на 5 меньше
   * предыдущего (классическое правило WoD20). Эффективные значения
   * инициативы: base, base-5, base-10, ...
   *
   * Стадия ЗАЯВОК: обход от меньшей инициативы к большей. Каждое действие
   * заявляется отдельным шагом — по всем эффективным значениям инициативы
   * всех участников (т.е. актёр с двумя действиями заявит их на своих двух
   * позициях). Так порядок заявок точно соответствует будущему порядку
   * разрешения действий.
   *
   * Стадия ДЕЙСТВИЙ: тот же плоский список, но обход от большей к меньшей.
   * За счёт этого чужие быстрые действия успевают разрешиться между двумя
   * действиями multi-action актёра (например, его второе действие на -5).
   */
  effectiveValues(c) {
    const n = Math.max(0, Math.floor(c.extraActions ?? 0));
    const vals = [];
    for (let k = 0; k <= n; k++) vals.push(c.initiative - 5 * k);
    return vals;
  }

  rebuildQueue() {
    const rows = [];
    for (const c of this.rolledCombatants()) {
      const vals = this.effectiveValues(c);
      vals.forEach((v, k) =>
        rows.push({ actorId: c.actorId, base: c.initiative, value: v, slot: k, count: vals.length })
      );
    }

    if (this.stage === "claims") {
      // от меньшей инициативы к большей; при равенстве — раньше заявляет
      // действие с более высокой базовой инициативой
      rows.sort((a, b) => a.value - b.value || b.base - a.base || a.slot - b.slot);
    } else {
      // от большей инициативы к меньшей; при равенстве — сначала основное
      // действие более инициативного актёра
      rows.sort((a, b) => b.value - a.value || b.base - a.base || a.slot - b.slot);
    }
    this.queue = rows;
  }

  /* ------------------------------ Ход боя ------------------------------ */

  async startCombat() {
    if (!this.allRolled()) return;
    this.round = 1;
    this.stage = "claims";
    this.rebuildQueue();
    this.turnIndex = 0;
    await ChatMessage.create({
      content: game.i18n.format("WODINI.ChatCombatStart", {}),
    });
    this.save();
  }

  async endCombat() {
    this.round = 0;
    this.stage = "idle";
    this.turnIndex = -1;
    this.queue = [];
    await ChatMessage.create({
      content: game.i18n.format("WODINI.ChatCombatEnd", {}),
    });
    this.save();
  }

  /**
   * Переключение следующего шага. Сначала отмечается завершённым ТЕКУЩИЙ
   * шаг (сообщение в чат), затем очередь сдвигается. Если текущий шаг уже
   * последний в стадии — происходит переход: claims -> actions,
   * actions -> новый раунд (claims) с сообщением в чат.
   */
  async nextStep() {
    if (this.stage === "idle" || this.queue.length === 0) return;
    const cur = this.queue[this.turnIndex];
    const actor = game.actors.get(cur.actorId);

    // Пишем сообщение о завершённом шаге ТЕКУЩЕГО участника.
    const key = this.stage === "claims" ? "WODINI.ChatDeclared" : "WODINI.ChatDone";
    await ChatMessage.create({
      content: game.i18n.format(key, { name: actor?.name ?? "?" }),
    });

    if (this.turnIndex + 1 < this.queue.length) {
      this.turnIndex += 1;
    } else if (this.stage === "claims") {
      // Переход к стадии действий.
      this.stage = "actions";
      this.rebuildQueue();
      this.turnIndex = 0;
    } else {
      // Новый раунд.
      this.round += 1;
      this.stage = "claims";
      this.rebuildQueue();
      this.turnIndex = 0;
      await ChatMessage.create({
        content: game.i18n.format("WODINI.ChatRound", { round: this.round }),
      });
    }
    this.save();
  }

  currentTurnActorId() {
    if (this.stage === "idle" || this.turnIndex < 0) return null;
    return this.queue[this.turnIndex]?.actorId ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* Чтение атрибутов Dexterity / Wits из системы WoD20                         */
/* -------------------------------------------------------------------------- */

function attrValue(actor, pathCandidates) {
  for (const p of pathCandidates) {
    const v = foundry.utils.getProperty(actor.system, p);
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (v && typeof v === "object" && typeof v.value === "number") return v.value;
  }
  return 0;
}

function readAttributes(actor) {
  // Структура атрибутов может отличаться между версиями WoD20 —
  // пробуем типовые пути.
  const dexPaths = [
    "attributes.dexterity.total",
    "attributes.dexterity.value",
    "attributes.dexterity",
    "attr.dex.total",
    "attr.dex.value",
  ];
  const witsPaths = [
    "attributes.wits.total",
    "attributes.wits.value",
    "attributes.wits",
    "attr.wit.total",
    "attr.wit.value",
  ];
  return {
    dex: attrValue(actor, dexPaths),
    wits: attrValue(actor, witsPaths),
  };
}

/* -------------------------------------------------------------------------- */
/* Панель                                                                     */
/* -------------------------------------------------------------------------- */

class InitiativePanel extends Application {
  static get defaultOptions() {
    const opts = foundry.utils.mergeObject(super.defaultOptions, {
      id: "wod-initiative-panel",
      classes: ["wod-ini-app"],
      title: game.i18n.localize("WODINI.PanelTitle"),
      template: `modules/${MODULE_ID}/templates/initiative-panel.hbs`,
      width: 460,
      popout: true,
      resizable: true,
    });
    return opts;
  }

  getData(options) {
    const state = panelState;
    const currentId = state.currentTurnActorId();
    const rows = state.combatants.map((c) => {
      const actor = game.actors.get(c.actorId);
      const n = Math.max(0, Math.floor(c.extraActions ?? 0));
      const slots =
        typeof c.initiative === "number" && n > 0
          ? panelState.effectiveValues(c).join(", ")
          : "";
      return {
        actorId: c.actorId,
        name: actor?.name ?? "(удалён)",
        initDisplay:
          typeof c.initiative === "number" ? String(c.initiative) : game.i18n.localize("WODINI.NotRolled"),
        extraSlots: slots,
        extra: c.extraActions ?? 0,
        current: c.actorId === currentId,
      };
    });

    let hint = "";
    if (state.stage === "idle") {
      if (state.combatants.length === 0) hint = "";
      else if (!state.allRolled()) hint = game.i18n.localize("WODINI.WaitingRolls");
    } else if (state.stage === "claims") {
      hint = game.i18n.localize("WODINI.CurrentTurn") + ": " +
        (game.actors.get(currentId)?.name ?? "?");
    } else if (state.stage === "actions") {
      hint = game.i18n.localize("WODINI.CurrentTurn") + ": " +
        (game.actors.get(currentId)?.name ?? "?");
    }

    return {
      rows,
      round: state.round || "-",
      stageLabel:
        state.stage === "claims"
          ? `${game.i18n.localize("WODINI.Stage")}: ${game.i18n.localize("WODINI.StageClaims")}`
          : state.stage === "actions"
          ? `${game.i18n.localize("WODINI.Stage")}: ${game.i18n.localize("WODINI.StageActions")}`
          : game.i18n.localize("WODINI.Stage") + ": —",
      combatActive: state.stage !== "idle",
      canStartCombat: state.stage === "idle" && state.allRolled(),
      canRemove: state.stage === "idle",
      hint,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find(".add-actor").click(async (ev) => {
      ev.preventDefault();
      const actors = [...game.actors]
        .filter((a) => a.isToken && !panelState.getCombatant(a.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (actors.length === 0) {
        ui.notifications.warn(game.i18n.localize("WODINI.AddActor"));
        return;
      }
      const choosers = actors
        .map((a) => `<option value="${a.id}">${a.name}</option>`)
        .join("");
      new Dialog(
        {
          title: game.i18n.localize("WODINI.AddActor"),
          content: `<form><select name="actorId" style="width:100%">${choosers}</select></form>`,
          buttons: {
            ok: {
              label: "OK",
              callback: async (dlg) => {
                const id = dlg.find("select[name='actorId']").val();
                if (id) {
                  panelState.addActor(id);
                  await this.render(true);
                }
              },
            },
          },
          default: "ok",
        },
        { width: 320 }
      ).render(true);
    });

    html.find(".roll-init").click(async (ev) => {
      ev.preventDefault();
      const id = $(ev.currentTarget).data("actor-id");
      await panelState.rollInitiative(String(id));
      await this.render(true);
    });

    html.find(".remove-actor").click((ev) => {
      ev.preventDefault();
      const id = $(ev.currentTarget).data("actor-id");
      panelState.removeActor(String(id));
      this.render(true);
    });

    html.find('input[name="extra-actions"]').change((ev) => {
      ev.preventDefault();
      const el = ev.currentTarget;
      const id = String($(el).data("actor-id"));
      panelState.setExtraActions(id, Number(el.value));
      this.render(true);
    });

    html.find(".start-combat").click(async (ev) => {
      ev.preventDefault();
      await panelState.startCombat();
      await this.render(true);
    });

    html.find(".next-step").click(async (ev) => {
      ev.preventDefault();
      await panelState.nextStep();
      await this.render(true);
    });

    html.find(".end-combat").click(async (ev) => {
      ev.preventDefault();
      await panelState.endCombat();
      await this.render(true);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Инициализация                                                              */
/* -------------------------------------------------------------------------- */

let panelState = null;
let panelApp = null;

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "state", {
    name: "Initiative State",
    scope: "world",
    config: false,
    type: Object,
    default: { combatants: [], round: 0, stage: "idle", turnIndex: -1 },
  });

  panelState = WodInitiativeState.load();
  if (panelState.stage !== "idle") panelState.rebuildQueue();
  panelApp = new InitiativePanel();

  window.WoDInitiative = {
    open: () => panelApp.render(true),
    state: panelState,
  };
});

// Кнопка на панели инструментов (для GM).
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const combat = controls.find((c) => c.name === "combat");
  if (!combat) return;
  combat.tools.push({
    name: "wod-initiative",
    title: "WODINI.ButtonLabel",
    icon: "fas fa-dice-d20",
    visible: game.user.isGM,
    onClick: () => panelApp.render(true),
    button: true,
  });
});

// Синхронизация состояния между клиентами через setting hook.
Hooks.on("updateWorldSetting", (setting, changes) => {
  if (setting.id !== `${MODULE_ID}.state`) return;
  panelState = WodInitiativeState.load();
  if (panelState.stage !== "idle") panelState.rebuildQueue();
  if (panelApp?.rendered) panelApp.render(false);
});
