"""Offline verification of the shared Claude/Codex document environment."""
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile, ZIP_DEFLATED
import json
import re
import subprocess
from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pptx.util import Inches
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageFont
import arabic_reshaper

def run(*args):
    return subprocess.run([str(arg) for arg in args], check=True, capture_output=True, text=True).stdout

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

    # Native extraction must include late pages, not only a preview or first batch.
    native = canvas.Canvas(str(root / 'all-pages.pdf'))
    for number in range(1, 126):
        native.drawString(40, 760, f'SOWALIF_PAGE_{number:03d}_COMPLETE')
        native.showPage()
    native.save()
    assert re.search(r'Pages:\s+125\b', run('pdfinfo', root / 'all-pages.pdf'))
    extracted = run('pdftotext', root / 'all-pages.pdf', '-')
    assert all(f'SOWALIF_PAGE_{number:03d}_COMPLETE' in extracted for number in range(1, 126))

    # Scanned pages contain pixels only; render and OCR every page.
    scanned = canvas.Canvas(str(root / 'scanned.pdf'), pagesize=(600, 400))
    font = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', 48)
    labels = ['FIRSTPAGE123', 'LASTPAGE456']
    for word in labels:
        image = Image.new('RGB', (1200, 800), 'white')
        ImageDraw.Draw(image).text((80, 200), word, fill='black', font=font)
        scanned.drawInlineImage(image, 0, 0, width=600, height=400)
        scanned.showPage()
    scanned.save()
    assert not run('pdftotext', root / 'scanned.pdf', '-').strip(), 'Scanned fixture must not contain native PDF text'
    run('pdftoppm', '-r', '150', '-png', root / 'scanned.pdf', root / 'scan')
    pages = sorted(root.glob('scan-*.png'))
    assert len(pages) == len(labels)
    for page, expected in zip(pages, labels, strict=True):
        text = run('tesseract', page, 'stdout', '-l', 'eng', '--psm', '6')
        # OCR may segment the synthetic token as "FIRSTPAGE1 23". Require
        # every character on its own page, allowing only whitespace variation.
        assert re.sub(r'\s+', '', text) == expected, f'{page.name}: expected {expected!r}, got {text!r}'
    languages = run('tesseract', '--list-langs')
    assert 'ara' in languages.splitlines() and 'eng' in languages.splitlines()

    # Inspect and extract complete compressed archives, including late entries.
    archive_path = root / 'complete.zip'
    with ZipFile(archive_path, 'w', compression=ZIP_DEFLATED) as archive:
        for number in range(121):
            archive.writestr(f'pages/page-{number:03d}.txt', f'Complete page {number}')
    run('7z', 't', archive_path)
    listing = json.loads(run('lsar', '-j', archive_path))
    assert len(listing['lsarContents']) == 121
    run('unar', '-o', root / 'expanded', archive_path)
    late = list((root / 'expanded').rglob('page-120.txt'))
    assert len(late) == 1 and late[0].read_text() == 'Complete page 120'
    run('7z', 'a', root / 'complete.7z', archive_path)
    run('7z', 't', root / 'complete.7z')
    print('PASS: Arabic PDF, DOCX, XLSX formulas, PPTX; 125 PDF pages; scanned PDF OCR on every page; Arabic/English OCR languages; 121 ZIP entries and extraction; 7z create/test; unar/lsar installed for archive formats including RAR')
