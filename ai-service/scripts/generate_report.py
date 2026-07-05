"""Generate a realistic mock annual-report PDF for the RAG knowledge base.

Run once to populate ai-service/knowledge/ with a demo report whose contents match the
seeded demo questions (dividend, results, buyback, board, ESG, expansion). This gives the
RAG draft chain real, citable facts to ground its answers.

    python scripts/generate_report.py
"""
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

OUT = Path(__file__).resolve().parent.parent / "knowledge" / "nimbus-annual-report-2024.pdf"

SECTIONS = [
    ("Nimbus Technologies Limited — Annual Report 2024",
     "Nimbus Technologies Limited (BSE: NIMBUS) is a mid-cap enterprise software company "
     "headquartered in Bengaluru, India. This report covers the financial year ended 31 March 2024."),

    ("Dividend",
     "The Board of Directors has recommended a final dividend of Rs. 4.50 per equity share "
     "(face value Rs. 10), a payout ratio of 32% of net profit. Subject to shareholder approval "
     "at this Annual General Meeting, the record date for the dividend is 12 August 2024 and the "
     "dividend will be paid on or before 5 September 2024. This is a 12.5% increase over the "
     "prior-year dividend of Rs. 4.00 per share."),

    ("Financial Results",
     "Total revenue for FY2024 was Rs. 4,820 crore, up 18.3% year over year from Rs. 4,074 crore. "
     "Net profit rose 21% to Rs. 712 crore. EBITDA margin improved to 24.6% from 22.9%. Revenue "
     "from cloud and subscription products grew 34% and now contributes 41% of total revenue. "
     "The company closed the year debt-free with cash and equivalents of Rs. 1,290 crore."),

    ("Share Buyback",
     "During the year the company completed a share buyback of Rs. 300 crore, repurchasing "
     "approximately 1.1% of outstanding equity at an average price of Rs. 1,180 per share via the "
     "open-market route. The buyback was funded entirely from free cash flow. No further buyback "
     "is planned for FY2025; capital return will be through dividends."),

    ("Board of Directors",
     "The Board comprises ten directors, of whom six are independent. During the year, "
     "Ms. Ananya Rao was appointed as an Independent Director, and Mr. Vikram Shah retired after "
     "nine years of service. Ms. Priya Menon continues as Chairperson and Mr. Arjun Nair as "
     "Managing Director and CEO. The Board met seven times during the financial year."),

    ("Environmental, Social and Governance (ESG)",
     "Nimbus achieved 68% renewable-energy sourcing across its campuses and targets carbon "
     "neutrality for Scope 1 and Scope 2 emissions by 2030. Women represent 39% of the total "
     "workforce and 28% of leadership roles. The company invested Rs. 22 crore in CSR programmes "
     "focused on digital-skills education, reaching over 40,000 students."),

    ("Business Expansion and Outlook",
     "The company opened a new delivery centre in Pune and expanded its North America sales "
     "presence with offices in Austin and Toronto. For FY2025, management guides revenue growth "
     "of 15-17% and expects EBITDA margin to remain in the 24-25% range. Headcount stood at "
     "11,400 employees at year end, a net addition of 1,250 during the year."),

    ("Auditors and Compliance",
     "The statutory auditors issued an unqualified opinion on the financial statements. The "
     "company reported no material weaknesses in internal financial controls. All quarterly "
     "results were filed within regulatory timelines and the company remained compliant with "
     "SEBI Listing Obligations and Disclosure Requirements throughout the year."),
]


def build() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("t", parent=styles["Title"], fontSize=18, spaceAfter=14)
    head_style = ParagraphStyle("h", parent=styles["Heading2"], fontSize=13, spaceBefore=10, spaceAfter=6)
    body_style = ParagraphStyle("b", parent=styles["BodyText"], fontSize=10.5, leading=15)

    doc = SimpleDocTemplate(str(OUT), pagesize=A4,
                            leftMargin=22 * mm, rightMargin=22 * mm,
                            topMargin=20 * mm, bottomMargin=20 * mm)
    flow = []
    for i, (head, body) in enumerate(SECTIONS):
        flow.append(Paragraph(head, title_style if i == 0 else head_style))
        flow.append(Paragraph(body, body_style))
        flow.append(Spacer(1, 6))
    doc.build(flow)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    build()
