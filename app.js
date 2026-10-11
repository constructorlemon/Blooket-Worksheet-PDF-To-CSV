(function () {
  "use strict";

  var PDFJS_WORKER =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  var CSV_HEADER = [
    "Question",
    "Correct Answer",
    "Incorrect Answer 1",
    "Incorrect Answer 2",
    "Incorrect Answer 3",
  ];

  // ---------------------------------------------------------------------------
  // pdf.js setup
  // ---------------------------------------------------------------------------

  var workerReady = null;

  function configureWorker() {
    var pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      return Promise.reject(new Error("pdf.js failed to load. Check your connection."));
    }
    if (workerReady) return workerReady;

    // Fetch the worker and run it from a blob so the page also works when opened
    // directly from disk (cross-origin workers are otherwise blocked).
    workerReady = fetch(PDFJS_WORKER)
      .then(function (res) {
        if (!res.ok) throw new Error("worker fetch failed");
        return res.text();
      })
      .then(function (code) {
        var url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
        pdfjsLib.GlobalWorkerOptions.workerSrc = url;
      })
      .catch(function () {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      });

    return workerReady;
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  function extractQuestions(pdfData) {
    var pdfjsLib = window.pdfjsLib;
    var qre = /^(\d{1,3})\.\s*(.*)$/;
    var ore = /^([a-e])\)\s*(.*)$/;
    var questions = [];
    var cur = null;

    return pdfjsLib
      .getDocument({ data: pdfData, useSystemFonts: false, isEvalSupported: false })
      .promise.then(function (doc) {
        var chain = Promise.resolve();

        var _loop = function (p) {
          chain = chain.then(function () {
            return doc.getPage(p).then(function (page) {
              return page.getOperatorList().then(function () {
                return page.getTextContent().then(function (tc) {
                  var nameMap = {};
                  tc.items.forEach(function (it) {
                    if (!it.str) return;
                    if (!(it.fontName in nameMap)) {
                      try {
                        nameMap[it.fontName] = page.commonObjs.get(it.fontName).name || it.fontName;
                      } catch (e) {
                        nameMap[it.fontName] = it.fontName;
                      }
                    }
                  });

                  var width = page.getViewport({ scale: 1 }).width;
                  var mid = width * 0.4;

                  var items = tc.items.filter(function (it) {
                    return it.str && it.str.length && !/arial/i.test(nameMap[it.fontName] || "");
                  });
                  items.sort(function (a, b) {
                    return b.transform[5] - a.transform[5];
                  });

                  var rows = [];
                  var row = null;
                  var rowY = null;
                  items.forEach(function (it) {
                    var y = it.transform[5];
                    if (row && Math.abs(y - rowY) <= 3) {
                      row.push(it);
                    } else {
                      row = [it];
                      rowY = y;
                      rows.push(row);
                    }
                  });

                  rows.forEach(function (r) {
                    var byX = function (a, b) {
                      return a.transform[4] - b.transform[4];
                    };
                    var left = r.filter(function (it) {
                      return it.transform[4] < mid;
                    }).sort(byX);
                    var right = r.filter(function (it) {
                      return it.transform[4] >= mid;
                    }).sort(byX);

                    [left, right].forEach(function (cluster) {
                      if (!cluster.length) return;
                      var text = cluster
                        .map(function (it) {
                          return it.str;
                        })
                        .join("")
                        .replace(/\s+/g, " ")
                        .trim();
                      if (!text) return;
                      if (/Question Set|Answer Key/.test(text)) return;

                      var firstRun = cluster.find(function (it) {
                        return it.str.trim();
                      }) || cluster[0];
                      var fontName = nameMap[firstRun.fontName] || "";
                      var isCorrect = /-Bold$/.test(fontName);
                      var isQuestionFont = /SemiBold/.test(fontName);
                      var col = cluster === left ? "L" : "R";

                      var m = qre.exec(text);
                      if (m && (cur === null || Number(m[1]) === questions.length + 1)) {
                        cur = { question: m[2].trim(), options: [], last: {} };
                        questions.push(cur);
                        return;
                      }
                      m = ore.exec(text);
                      if (m && cur) {
                        var opt = { text: m[2].trim(), correct: isCorrect };
                        cur.options.push(opt);
                        cur.last[col] = opt;
                        return;
                      }
                      if (!cur) return;
                      if (isQuestionFont) {
                        cur.question = (cur.question + " " + text).trim();
                      } else if (cur.last[col]) {
                        cur.last[col].text = (cur.last[col].text + " " + text).trim();
                      }
                    });
                  });
                });
              });
            });
          });
        };

        for (var p = 1; p <= doc.numPages; p++) _loop(p);

        return chain.then(function () {
          return doc.destroy();
        }).then(function () {
          return questions;
        });
      });
  }

  // ---------------------------------------------------------------------------
  // CSV building
  // ---------------------------------------------------------------------------

  function answerRow(q) {
    var corrects = q.options.filter(function (o) {
      return o.correct;
    });
    var primary = corrects[0] || q.options[0] || { text: "" };
    var distractors = q.options
      .filter(function (o) {
        return o !== primary;
      })
      .map(function (o) {
        return o.text;
      });
    while (distractors.length < 3) distractors.push("");
    return [q.question, primary.text].concat(distractors.slice(0, 3));
  }

  function csvCell(value) {
    var s = String(value == null ? "" : value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(questions) {
    var lines = [CSV_HEADER.map(csvCell).join(",")];
    questions.forEach(function (q) {
      lines.push(answerRow(q).map(csvCell).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  // ---------------------------------------------------------------------------
  // Report data
  // ---------------------------------------------------------------------------

  function analyze(questions) {
    var multi = [];
    var thin = [];
    var totalCorrect = 0;

    questions.forEach(function (q, i) {
      var corrects = q.options.filter(function (o) {
        return o.correct;
      });
      totalCorrect += corrects.length;
      if (corrects.length > 1) {
        multi.push({ number: i + 1, question: q.question, answers: corrects.map(function (o) { return o.text; }) });
      }
      if (q.options.length < 4) {
        thin.push({ number: i + 1, question: q.question, count: q.options.length });
      }
    });

    return { multi: multi, thin: thin, totalCorrect: totalCorrect };
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    var input = $("fileInput");
    var dropzone = $("dropzone");
    var status = $("status");
    var results = $("results");
    var summary = $("summary");
    var downloadBtn = $("downloadBtn");
    var multiReport = $("multiReport");
    var multiList = $("multiList");
    var thinReport = $("thinReport");
    var thinList = $("thinList");

    var state = { csv: "", fileName: "blooket.csv" };

    function setStatus(html, kind) {
      status.hidden = false;
      status.className = "status" + (kind ? " is-" + kind : "");
      status.innerHTML = html;
    }

    function reset() {
      results.hidden = true;
      downloadBtn.disabled = true;
      state.csv = "";
    }

    function renderMulti(report) {
      var title = multiReport.querySelector(".report__title");
      multiList.innerHTML = "";
      title.textContent =
        "Questions with multiple correct answers (" + report.multi.length + ")";
      if (!report.multi.length) {
        var li = document.createElement("li");
        li.textContent = "None - every question had a single correct answer.";
        multiList.appendChild(li);
        return;
      }
      report.multi.forEach(function (item) {
        var li = document.createElement("li");
        var q = document.createElement("span");
        q.className = "report__q";
        q.textContent = "Q" + item.number + ": " + item.question;
        li.appendChild(q);

        var ul = document.createElement("ul");
        ul.className = "report__answers";
        item.answers.forEach(function (ans, idx) {
          var a = document.createElement("li");
          a.textContent = ans;
          var tag = document.createElement("span");
          if (idx === 0) {
            tag.className = "tag";
            tag.textContent = "kept as correct";
          } else {
            tag.className = "tag tag--drop";
            tag.textContent = "moved to incorrect";
          }
          a.appendChild(tag);
          ul.appendChild(a);
        });
        li.appendChild(ul);
        multiList.appendChild(li);
      });
    }

    function renderThin(report) {
      var title = thinReport.querySelector(".report__title");
      thinList.innerHTML = "";
      title.textContent = "Questions with fewer than 4 answers (" + report.thin.length + ")";
      if (!report.thin.length) {
        thinReport.hidden = true;
        return;
      }
      thinReport.hidden = false;
      report.thin.forEach(function (item) {
        var li = document.createElement("li");
        li.textContent = "Q" + item.number + " (" + item.count + " answers): " + item.question;
        thinList.appendChild(li);
      });
    }

    function handleFile(file) {
      if (!file) return;
      reset();

      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        setStatus("Please choose a PDF file.", "error");
        return;
      }

      setStatus("Reading <strong>" + escapeHtml(file.name) + "</strong>...");

      var reader = new FileReader();
      reader.onerror = function () {
        setStatus("Could not read that file.", "error");
      };
      reader.onload = function () {
        var data = new Uint8Array(reader.result);
        setStatus("Parsing PDF and detecting correct answers...");

        configureWorker()
          .then(function () {
            return extractQuestions(data);
          })
          .then(function (questions) {
            if (!questions.length) {
              setStatus(
                "No questions were found. Make sure this is a Blooket &ldquo;Question Set &ndash; Answer Key&rdquo; PDF.",
                "error"
              );
              return;
            }

            var report = analyze(questions);
            state.csv = toCsv(questions);
            state.fileName = file.name.replace(/\.pdf$/i, "") + ".csv";

            var answerNote =
              report.totalCorrect === 0
                ? " <strong>(no bolded answers detected - check that this is an answer key)</strong>"
                : "";
            setStatus(
              "Parsed <strong>" + questions.length + "</strong> questions." + answerNote,
              report.totalCorrect === 0 ? "error" : "ok"
            );

            summary.textContent =
              questions.length + " questions \u00b7 " + report.multi.length + " with multiple answers";
            renderMulti(report);
            renderThin(report);
            multiReport.hidden = false;
            results.hidden = false;
            downloadBtn.disabled = false;
          })
          .catch(function (err) {
            setStatus(
              "Something went wrong while parsing: " + escapeHtml(err && err.message ? err.message : String(err)),
              "error"
            );
          });
      };
      reader.readAsArrayBuffer(file);
    }

    input.addEventListener("change", function () {
      if (input.files && input.files[0]) handleFile(input.files[0]);
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.remove("is-dragover");
      });
    });
    dropzone.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
    dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });

    downloadBtn.addEventListener("click", function () {
      if (!state.csv) return;
      var blob = new Blob(["\ufeff" + state.csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = state.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractQuestions: extractQuestions, toCsv: toCsv, analyze: analyze };
  }
})();
