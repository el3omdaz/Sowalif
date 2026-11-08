"""Offline verification of the shared Claude/Codex document environment."""
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pptx.util import Inches
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from bidi.algorithm import get_display
import arabic_reshaper

with TemporaryDirectory() as folder:
    root = Path(folder)
    pdfmetrics.registerFont(TTFont('Arabic', '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf'))
    pdf = canvas.Canvas(str(root / 'report.pdf'))
    pdf.setFont('Arabic', 18)
    pdf.drawRightString(550, 760, get_display(arabic_reshaper.reshape('تقرير سوالف')))
    pdf.save()
    assert (root / 'report.pdf').read_bytes().startswith(b'%PDF-')
    word = Document()
    word.add_heading('تقرير سوالف', 0)
    word.add_paragraph('Document creation smoke test')
    word.save(root / 'report.docx')
    assert Document(root / 'report.docx').paragraphs[0].text == 'تقرير سوالف'
    book = Workbook()
    book.active.append(['الكمية', 'السعر', 'الإجمالي'])
    book.active.append([2, 10, '=A2*B2'])
    book.active.sheet_view.rightToLeft = True
    book.save(root / 'budget.xlsx')
    reopened = load_workbook(root / 'budget.xlsx')
    assert reopened.active['C2'].value == '=A2*B2'
    slides = Presentation()
    slide = slides.slides.add_slide(slides.slide_layouts[6])
    slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1)).text = 'سوالف'
    slides.save(root / 'slides.pptx')
    assert len(Presentation(root / 'slides.pptx').slides) == 1
    for name in ['report.docx', 'budget.xlsx', 'slides.pptx']:
        with ZipFile(root / name) as archive:
            assert archive.testzip() is None
    print('PASS: PDF with embedded Arabic font, DOCX reopen, XLSX formulas, PPTX reopen')
