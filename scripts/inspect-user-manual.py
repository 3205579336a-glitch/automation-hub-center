"""Read-only manual checks, optional Poppler render and QA contact sheets."""
from pathlib import Path
import argparse
import json
import re
import subprocess
from PIL import Image, ImageDraw
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
QA = ROOT/"tmp"/"pdfs"
POPPLER = Path("C:/Users/A533700/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe")


def inspect(render=False):
    code = "\n".join(p.read_text(encoding="utf-8") for folder in ("src", "resources/rpa")
                     for p in (ROOT/folder).rglob("*") if p.suffix in (".ts", ".tsx", ".py"))
    en = (ROOT/"docs"/"USER_MANUAL.md").read_text(encoding="utf-8")
    reference = en.split("### 20.2")[1].split("### 20.3")[0]
    rows = [l.split("|")[1].strip() for l in reference.splitlines() if l.startswith("| ")][2:]
    identifiers = sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", " ".join(rows))))
    assert all(identifier in code for identifier in identifiers)
    version = json.loads((ROOT/"package.json").read_text(encoding="utf-8"))["version"]
    assert version == "0.2.4"
    report = {"version":version, "errorReferenceRows":len(rows), "technicalIdentifiers":len(identifiers),
              "languages":{}, "sapActions":0, "unmatchedIdentifiers":[]}
    QA.mkdir(parents=True, exist_ok=True)
    for lang, filename in (("EN", "USER_MANUAL.md"), ("ZH", "USER_MANUAL_ZH.md")):
        source = (ROOT/"docs"/filename).read_text(encoding="utf-8")
        assert len(re.findall(r"^## \d+\. ", source, re.M)) == 20
        assert re.findall(r'^<a id="section-(\d+)"', source, re.M) == [str(n) for n in range(1,21)]
        assert re.findall(r"^\| (\d{2})\.", source, re.M) == [f"{n:02}" for n in range(1,41)]
        pictures = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", source)
        assert len(pictures) == len(set(pictures)) == 16
        assert all((ROOT/"docs"/path).is_file() for path in pictures)
        numbers = re.findall(r"^\*(?:Figure |图)(\d+)", source, re.M)
        assert numbers == [str(n) for n in range(1,17)]
        pdf = ROOT/"output"/"pdf"/f"Purchasing_Automation_Hub_User_Manual_V0.2.4_{lang}.pdf"
        reader = PdfReader(pdf)
        texts = [p.extract_text() or "" for p in reader.pages]
        assert not any(len(t) < 100 for t in texts), "Possible empty body page"
        assert len(reader.outline) == 20
        assert "0.2.4" in texts[0]
        fulltext = "\n".join(texts)
        assert all(i in re.sub(r"\s+", "", fulltext) for i in identifiers)
        assert not any(c in fulltext for c in ("\u25a0", "\ufffd")), "Missing glyph marker"
        report["languages"][lang] = {"chapters":20,"troubleshootingCategories":40,"figures":16,
                                     "pages":len(texts),"outlineEntries":len(reader.outline),
                                     "portraitPages":sum(p.mediabox.width < p.mediabox.height for p in reader.pages)}
        if render:
            directory = QA/f"{lang}-{len(reader.pages)}"
            directory.mkdir(parents=True, exist_ok=True)
            subprocess.run([str(POPPLER), "-scale-to", "1400", "-png", str(pdf), str(directory/"page")], check=True)
            files = sorted(directory.glob("page-*.png"))
            assert len(files) == len(reader.pages)
            for start in range(0,len(files),12):
                sheet = Image.new("RGB",(1000,1480),"#CBD5DF")
                draw = ImageDraw.Draw(sheet)
                for j, file in enumerate(files[start:start+12]):
                    with Image.open(file) as page:
                        page.thumbnail((310,330))
                        x, y = (j%3)*333+(333-page.width)//2, (j//3)*370+30
                        sheet.paste(page,(x,y))
                    draw.text(((j%3)*333+12,(j//3)*370+9),f"{lang} page {start+j+1}", fill="black")
                sheet.save(QA/f"{lang}-contact-{start//12+1:02}.png")
    print(json.dumps(report,ensure_ascii=False))
    if render:
        sheet = Image.new("RGB",(1400,1400),"#D9E0E8")
        draw = ImageDraw.Draw(sheet)
        for j, path in enumerate(sorted((ROOT/"docs"/"manual-assets").glob("*.png"))):
            with Image.open(path) as picture:
                picture.thumbnail((330,306))
                x,y=(j%4)*350+(350-picture.width)//2,(j//4)*350+30
                sheet.paste(picture,(x,y))
            draw.text(((j%4)*350+8,(j//4)*350+8),path.name,fill="black")
        sheet.save(QA/"figures-contact.png")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--render",action="store_true")
    inspect(parser.parse_args().render)
