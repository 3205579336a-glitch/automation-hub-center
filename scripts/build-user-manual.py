"""Build the documentation-only, bilingual V0.2.4 print manuals.

Uses bundled ReportLab and Windows fonts; does not access SAP or modify the app.
Wide interface illustrations receive a landscape sheet for print legibility.
"""
from pathlib import Path
import html
import re
import json

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, PageBreak,
    NextPageTemplate, Table, TableStyle, Image, KeepTogether, CondPageBreak,
)
from reportlab.platypus.tableofcontents import TableOfContents
from PIL import Image as PILImage
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf"
OUTPUT.mkdir(parents=True, exist_ok=True)
FONT_ROOT = Path("C:/Windows/Fonts")
for name, filename in [
    ("Body", "calibri.ttf"), ("BodyBold", "calibrib.ttf"),
    ("BodyItalic", "calibrii.ttf"), ("CJK", "msyh.ttc"), ("CJKBold", "msyhbd.ttc"),
]:
    pdfmetrics.registerFont(TTFont(name, str(FONT_ROOT / filename), subfontIndex=0))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="BodyBold", italic="BodyItalic", boldItalic="BodyBold")
pdfmetrics.registerFontFamily("CJK", normal="CJK", bold="CJKBold", italic="CJK", boldItalic="CJKBold")

NAVY = colors.HexColor("#153554")
BLUE = colors.HexColor("#1663B7")
GRAY = colors.HexColor("#596879")
LINE = colors.HexColor("#CCD5DF")
PALE = colors.HexColor("#F1F5F9")
W, H = A4
MARGIN = 19 * mm
WIDTH = W - 2 * MARGIN
CJK_RE = re.compile(r"[\u3400-\u9fff]")


def inline(raw):
    # Normalize typographic dash variants for consistent PDF printing.
    raw = re.sub(r"[\u2010-\u2015]", "-", raw)
    value = html.escape(raw)
    value = re.sub(r"`([^`]+)`", r'<font color="#294D70">\1</font>', value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
    value = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", value)
    value = re.sub(r"\[([^\]]+)\]\((#[^)]+)\)", r'<link href="\2" color="#1663B7">\1</link>', value)
    value = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<link href="\2" color="#1663B7">\1</link>', value)
    return value


class ManualDoc(BaseDocTemplate):
    def __init__(self, path, zh):
        self.zh = zh
        self.docid = "PAH-UM-ZH-024" if zh else "PAH-UM-EN-024"
        super().__init__(str(path), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                         topMargin=22 * mm, bottomMargin=20 * mm,
                         title="Purchasing Automation Hub V0.2.4 - " + ("用户操作手册" if zh else "User Manual"),
                         author="VCE China Purchasing Development / System")
        self.addPageTemplates([
            PageTemplate(id="portrait", pagesize=A4,
                         frames=Frame(MARGIN, 20*mm, WIDTH, H-42*mm, leftPadding=0, rightPadding=0,
                                      topPadding=0, bottomPadding=0), onPage=self.decorate),
            PageTemplate(id="landscape", pagesize=landscape(A4),
                         frames=Frame(MARGIN, 18*mm, H-2*MARGIN, W-38*mm, leftPadding=0, rightPadding=0,
                                      topPadding=0, bottomPadding=0), onPage=self.decorate),
        ])

    def decorate(self, canvas, doc):
        canvas.saveState()
        pw, ph = doc.pageTemplate.pagesize
        canvas.setFont("Body", 8.5)
        canvas.setFillColor(GRAY)
        if doc.page != 1:
            canvas.drawString(MARGIN, ph - 13*mm, "Purchasing Automation Hub | V0.2.4")
            canvas.drawRightString(pw-MARGIN, ph-13*mm, self.docid)
            canvas.setStrokeColor(LINE)
            canvas.line(MARGIN, ph-16*mm, pw-MARGIN, ph-16*mm)
        canvas.setStrokeColor(LINE)
        canvas.line(MARGIN, 14*mm, pw-MARGIN, 14*mm)
        canvas.drawString(MARGIN, 9*mm, "Internal Use Only | Manual 1.0 | 2026-10-13")
        canvas.drawRightString(pw-MARGIN, 9*mm, str(doc.page))
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and hasattr(flowable, "toc_key"):
            key = flowable.toc_key
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(flowable.getPlainText(), key, level=0)
            self.notify("TOCEntry", (0, flowable.getPlainText(), self.page, key))


def build(lang):
    zh = lang == "ZH"
    font = "CJK" if zh else "Body"
    bold = "CJKBold" if zh else "BodyBold"
    styles = {
        "body": ParagraphStyle("body", fontName=font, fontSize=10.6 if zh else 11,
                               leading=16.3 if zh else 15.8, spaceAfter=6, textColor=colors.HexColor("#172737"),
                               splitLongWords=True, wordWrap="CJK" if zh else None),
        "h2": ParagraphStyle("h2", fontName=bold, fontSize=19, leading=26,
                             spaceBefore=4, spaceAfter=14, keepWithNext=True, textColor=NAVY),
        "h3": ParagraphStyle("h3", fontName=bold, fontSize=13.2, leading=19,
                             spaceBefore=10, spaceAfter=7, keepWithNext=True, textColor=NAVY),
        "h4": ParagraphStyle("h4", fontName=bold, fontSize=11.4, leading=17,
                             spaceBefore=10, spaceAfter=6, keepWithNext=True, textColor=NAVY),
        "caption": ParagraphStyle("caption", fontName=font, fontSize=9, leading=14,
                                  spaceBefore=8, spaceAfter=12, textColor=GRAY),
        "cell": ParagraphStyle("cell", fontName=font, fontSize=9 if zh else 9.2, leading=13.2,
                               spaceAfter=0, splitLongWords=True, wordWrap="CJK" if zh else None),
        "callout": ParagraphStyle("callout", fontName=font, fontSize=10.5, leading=16,
                                  borderPadding=9, borderColor=LINE, borderWidth=0.5, backColor=PALE,
                                  spaceBefore=7, spaceAfter=12, splitLongWords=True,
                                  wordWrap="CJK" if zh else None),
        "bullet": ParagraphStyle("bullet", fontName=font, fontSize=10.6 if zh else 11, leading=16.3,
                                 leftIndent=14, firstLineIndent=-12, spaceAfter=6,
                                 wordWrap="CJK" if zh else None),
        "code": ParagraphStyle("code", fontName=font, fontSize=9.5, leading=14.5,
                               backColor=PALE, borderPadding=8, spaceAfter=8, splitLongWords=True,
                               wordWrap="CJK" if zh else None),
    }

    def para(raw, style="body"):
        st = styles[style]
        if not zh and CJK_RE.search(raw):
            st = ParagraphStyle(st.name+"mixed", parent=st, fontName="CJK", wordWrap="CJK")
        return Paragraph(inline(raw), st)

    lines = (ROOT / "docs" / ("USER_MANUAL_ZH.md" if zh else "USER_MANUAL.md")).read_text(encoding="utf-8").splitlines()
    story = []
    story.append(Spacer(1, 26*mm))
    title_style = ParagraphStyle("cover-title", fontName="BodyBold", fontSize=32, leading=38, textColor=NAVY)
    story.append(Paragraph("Purchasing<br/>Automation Hub", title_style))
    story.append(Spacer(1, 7*mm))
    story.append(Paragraph("用户操作手册" if zh else "User Manual", ParagraphStyle("cover-subtitle", fontName=bold, fontSize=24, leading=34)))
    story.append(Spacer(1, 12*mm))
    metadata_start = next(i for i,l in enumerate(lines) if l.startswith("**"))
    metadata_end = metadata_start
    while metadata_end < len(lines) and lines[metadata_end].startswith("**"):
        story.append(para(lines[metadata_end]))
        metadata_end += 1
    story.append(Spacer(1, 12*mm))
    story.append(para("Four released tasks. One standard batch workflow." if not zh else "四个已发布功能，统一的模板批量操作流程。"))
    story.append(para("Download template → Fill and save → Upload → Review → Start → Check results" if not zh else "下载模板 → 填写并保存 → 上传 → 核对 → 开始 → 查看结果"))
    story.append(PageBreak())

    def make_table(rows):
        count = len(rows[0])
        first = " ".join(rows[0])
        if count == 5 and ("Retry" in first or "重试" in first):
            ratios = [.23, .18, .32, .13, .14]
        elif count == 5:
            ratios = [.18, .26, .16, .23, .17]
        elif count == 4:
            ratios = [.18, .18, .18, .46]
        elif count == 3:
            if "Identifier" in first or "标识" in first:
                ratios = [.39, .32, .29]
            elif "Original versus result" in first or "原文件与结果" in first:
                ratios = [.16, .44, .40]
            else:
                ratios = [.14, .29, .57]
        elif count == 2:
            ratios = [.4, .6]
        else:
            ratios = [1/count]*count
        values = [[para(cell, "cell") for cell in row] for row in rows]
        header_style = ParagraphStyle("table-head", parent=styles["cell"], fontName=bold, textColor=colors.white)
        values[0] = [Paragraph(inline(c), header_style) for c in rows[0]]
        table = Table(values, colWidths=[WIDTH*r for r in ratios], repeatRows=1, hAlign="LEFT")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0,0), (-1,0), NAVY), ("VALIGN", (0,0), (-1,-1), "TOP"),
            ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, PALE]),
            ("LINEBELOW", (0,0), (-1,-1), .4, LINE),
            ("LEFTPADDING", (0,0), (-1,-1), 7), ("RIGHTPADDING", (0,0), (-1,-1), 7),
            ("TOPPADDING", (0,0), (-1,-1), 6), ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ]))
        return table

    i = metadata_end
    figure_count = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line.startswith("<a id="):
            i += 1
            continue
        if line in ("## Contents", "## 目录"):
            story.append(PageBreak())
            story.append(para("目录" if zh else "Contents", "h2"))
            toc = TableOfContents()
            toc.levelStyles = [ParagraphStyle("toc", fontName=font, fontSize=10.5, leading=19,
                                              firstLineIndent=0, leftIndent=0, rightIndent=26,
                                              textColor=NAVY, spaceAfter=4)]
            story.append(toc)
            i += 1
            while i < len(lines) and not lines[i].startswith('<a id="section-1"'):
                i += 1
            continue
        h = re.match(r"^(#{2,4})\s+(.+)$", line)
        if h:
            level, text = len(h[1]), h[2]
            if level == 2 and re.match(r"\d+\. ", text):
                if not isinstance(story[-1], PageBreak):
                    story.append(PageBreak())
                heading = para(text, "h2")
                heading.toc_key = "section-"+text.split(".",1)[0]
                story.append(heading)
            else:
                next_line = next((l.strip() for l in lines[i+1:] if l.strip()), "")
                heading = para(text, "h"+str(level))
                if next_line.startswith("|"):
                    story.append(CondPageBreak(150))
                    table_lines = []
                    for following in lines[i+1:]:
                        if following.strip().startswith("|"):
                            table_lines.append(following)
                        elif table_lines:
                            break
                    # Keep short reference tables intact; allow long error tables to split.
                    heading.keepWithNext = len(table_lines) <= 9
                story.append(heading)
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r"[: -]+", c) for c in cells):
                    rows.append(cells)
                i += 1
            assert len({len(r) for r in rows}) == 1, "Malformed manual table"
            story.append(make_table(rows))
            story.append(Spacer(1, 9))
            continue
        picture = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", line)
        if picture:
            path = ROOT/"docs"/picture[2]
            with PILImage.open(path) as im:
                iw, ih = im.size
            caption_index = i+1
            while caption_index < len(lines) and not lines[caption_index].strip():
                caption_index += 1
            caption = lines[caption_index].strip().strip("*")
            assert caption.startswith("Figure ") or caption.startswith("图"), "Figure needs caption"
            if iw > 1100:
                story.extend([NextPageTemplate("landscape"), PageBreak()])
                maxw, maxh = H-2*MARGIN, W-55*mm
                scale = min(maxw/iw, maxh/ih)
                story.extend([Image(str(path), iw*scale, ih*scale, hAlign="LEFT"), para(caption,"caption"),
                              NextPageTemplate("portrait"), PageBreak()])
            else:
                scale = min(WIDTH/iw, 490/ih, 1)
                story.append(KeepTogether([Image(str(path), iw*scale, ih*scale, hAlign="LEFT"), para(caption,"caption")]))
            figure_count += 1
            i = caption_index+1
            continue
        if line.startswith("```"):
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            story.append(Paragraph("<br/>".join(html.escape(s) for s in code), styles["code"]))
            i += 1
            continue
        if line.startswith(">"):
            raw = line.lstrip("> ")
            i += 1
            while i < len(lines) and lines[i].startswith(">"):
                raw += " "+lines[i].lstrip("> ")
                i += 1
            story.append(para(raw,"callout"))
            continue
        numbered = re.match(r"^(\d+)\. (.+)$", line)
        if numbered or line.startswith("- "):
            text = numbered[1]+". "+numbered[2] if numbered else "• "+line[2:]
            story.append(para(text,"bullet"))
            i += 1
            continue
        raw = line
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|\||>|<a |!\[|```|- |\d+\. )", lines[i].strip()):
            raw += " "+lines[i].strip()
            i += 1
        story.append(para(raw))

    path = OUTPUT/f"Purchasing_Automation_Hub_User_Manual_V0.2.4_{lang}.pdf"
    doc = ManualDoc(path, zh)
    doc.multiBuild(story)
    reader = PdfReader(path)
    text = "\n".join(p.extract_text() or "" for p in reader.pages)
    assert figure_count == 16
    assert "V0.2.4" in text
    assert all(p.extract_text() for p in reader.pages), "Empty page"
    for number in range(1,17):
        assert (f"图{number} " if zh else f"Figure {number} -") in text, f"Lost figure {number}"
    print(json.dumps({"language":lang,"path":str(path),"pages":len(reader.pages),
                      "figures":figure_count,"bytes":path.stat().st_size},ensure_ascii=False))


if __name__ == "__main__":
    for language in ("EN", "ZH"):
        build(language)
