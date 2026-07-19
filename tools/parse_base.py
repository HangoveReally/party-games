# -*- coding: utf-8 -*-
"""Парсер БАЗА_вопросов.md -> js/questions.js"""
import re, json, io

SRC = r"b:\claude\Пати-игры\БАЗА_вопросов.md"
OUT = r"b:\claude\Пати-игры\js\questions.js"

with io.open(SRC, encoding="utf-8") as f:
    lines = f.read().split("\n")

q_re = re.compile(r"^\*\*(\d+)\.\s*(.+?)\*\*\s*$")
ans_re = re.compile(r"^-\s*(.+?)\s+—\s+(\d+)\s*\{(.*)\}\s*$")

questions = []
cur = None
pack = ""
tag = "soft"

def push():
    global cur
    if cur and cur["answers"]:
        questions.append(cur)
    cur = None

for ln in lines:
    s = ln.rstrip()
    if s.startswith("## ") and "ПАК" in s:
        push()
        m = re.search(r"«(.+?)»", s)
        pack = m.group(1) if m else s[3:].strip()
        tag = "hot" if "· hot" in s or "·hot" in s else "soft"
        continue
    qm = q_re.match(s)
    if qm:
        push()
        cur = {"id": int(qm.group(1)), "pack": pack, "tag": tag,
               "q": qm.group(2).strip(), "h1": "", "h2": "", "answers": []}
        continue
    if cur is None:
        continue
    if s.startswith("💡"):
        body = s[1:].strip()
        if "🔍" in body:
            a, b = body.split("🔍", 1)
            cur["h1"] = a.strip().rstrip("·").strip()
            cur["h2"] = b.strip()
        else:
            cur["h1"] = body.strip()
        continue
    am = ans_re.match(s)
    if am:
        text = am.group(1).strip()
        pts = int(am.group(2))
        keys = [k.strip() for k in am.group(3).split(",") if k.strip()]
        cur["answers"].append({"t": text, "p": pts, "keys": keys})
        continue

push()

# сортировка ответов по убыванию очков (на всякий случай)
for q in questions:
    q["answers"].sort(key=lambda a: -a["p"])

js = "// АВТОГЕНЕРАЦИЯ из БАЗА_вопросов.md — не редактировать вручную.\n"
js += "// {id, pack, tag: soft|hot, q, h1, h2, answers:[{t, p, keys:[...]}]}\n"
js += "const QUESTIONS = " + json.dumps(questions, ensure_ascii=False, indent=0).replace("\n", "") + ";\n"
js += "window.QUESTIONS = QUESTIONS;\n"

import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with io.open(OUT, "w", encoding="utf-8") as f:
    f.write(js)

print("Вопросов:", len(questions))
print("Ответов всего:", sum(len(q["answers"]) for q in questions))
packs = {}
for q in questions:
    packs[q["pack"]] = packs.get(q["pack"], 0) + 1
print("Паки:", len(packs))
bad = [q["id"] for q in questions if len(q["answers"]) < 5]
print("Вопросы с <5 ответами:", bad)
