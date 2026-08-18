const express = require("express");
const escpos = require("escpos");
escpos.USB = require("escpos-usb");

const router = express.Router();

router.post("/print-receipt", (req, res) => {
  const { 
    account_name, 
    invoice_number, 
    customer_name, 
    items, 
    subtotal, 
    tax, 
    total 
  } = req.body;

  try {
    // Auto-detect connected USB printer (or pass vid, pid: new escpos.USB(0x04b8, 0x0e15))
    const device = new escpos.USB();
    const printer = new escpos.Printer(device);

    device.open((error) => {
      if (error) {
        console.error("USB Printer Error:", error);
        return res.status(500).json({ 
          success: false, 
          message: "Could not open USB thermal printer." 
        });
      }

      printer
        .font("a")
        .align("ct")
        .style("b")
        .size(1, 1)
        .text(account_name || "RECEIPT")
        .size(0, 0)
        .text("--------------------------------")
        .align("lt")
        .text(`Invoice #: ${invoice_number || ""}`)
        .text(`Customer : ${customer_name || ""}`)
        .text("--------------------------------");

      if (Array.isArray(items)) {
        items.forEach((item) => {
          const name = String(item.name || "").padEnd(20, " ").substring(0, 20);
          const price = `$${Number(item.total || 0).toFixed(2)}`.padStart(11, " ");
          printer.text(`${name}${price}`);
        });
      }

      printer
        .text("--------------------------------")
        .align("rt")
        .text(`Subtotal: $${subtotal || "0.00"}`)
        .text(`Tax: $${tax || "0.00"}`)
        .style("b")
        .text(`TOTAL: $${total || "0.00"}`)
        .style("b", false)
        .text("--------------------------------")
        .align("ct")
        .text("Thank you for your business!")
        .feed(3)
        .cut()
        .close();

      return res.json({ success: true, message: "Receipt printed successfully." });
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
